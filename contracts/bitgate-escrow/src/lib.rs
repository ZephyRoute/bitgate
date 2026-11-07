#![no_std]

//! BitGate: a peer-to-peer Bitcoin-for-USDC escrow on Soroban.
//!
//! A maker locks tokens (USDC) in an offer and names the Bitcoin
//! scriptPubKey they want to be paid at and a price in satoshis. A taker
//! reserves part of the offer with `take`, pays the satoshis on Bitcoin, and
//! anyone submits the SPV proof with `claim`. The escrow asks the Writz
//! `bitcoin-spv` light client to prove the payment is buried under the
//! offer's confirmations, parses the transaction itself to check it paid the
//! maker's script enough, and only then releases the tokens to the taker.
//! No bridge, no custodian, no wrapped Bitcoin, and neither side has to send
//! first and trust the other.
//!
//! Safety properties, each enforced on chain:
//! - A Bitcoin txid settles at most one trade.
//! - A payment mined at or below the light client tip recorded at `take` is
//!   refused, so an old payment to the maker's address cannot be replayed.
//! - One reservation per offer at a time, so a payment can only be meant for
//!   the trade that holds the offer.
//! - The taker's bond goes to the maker if the taker lets the reservation
//!   lapse, so reserving an offer without paying costs something.

mod error;
mod types;

#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod test;

pub use error::Error;
pub use types::{Config, DataKey, Offer, Reputation, Trade, TradeStatus};

use soroban_sdk::{contract, contractevent, contractimpl, token, Address, Bytes, BytesN, Env, Vec};
use writz_spv_client::{find_output_value, BitcoinSpvClient, SPVError};

/// Highest protocol fee the admin can set: 1%.
pub const MAX_FEE_BPS: u32 = 100;
/// Highest taker bond a maker can ask for: 10% of the fill.
pub const MAX_BOND_BPS: u32 = 1_000;
/// Most confirmations an offer can require (one day of Bitcoin blocks).
pub const MAX_CONFIRMATIONS: u32 = 144;
/// Shortest reservation window: ten minutes, about one Bitcoin block.
pub const MIN_WINDOW_SECS: u64 = 10 * 60;
/// Longest reservation window: three days.
pub const MAX_WINDOW_SECS: u64 = 3 * 24 * 60 * 60;
/// Smallest payment a Bitcoin node relays to a standard output.
pub const DUST_SATS: u64 = 546;
/// Longest scriptPubKey accepted. Standard scripts are at most 34 bytes.
pub const MAX_SCRIPT_LEN: u32 = 64;

const BPS: i128 = 10_000;
const DAY_IN_LEDGERS: u32 = 17_280;
const INSTANCE_BUMP: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_THRESHOLD: u32 = INSTANCE_BUMP - DAY_IN_LEDGERS;
const PERSISTENT_BUMP: u32 = 60 * DAY_IN_LEDGERS;
const PERSISTENT_THRESHOLD: u32 = PERSISTENT_BUMP - 7 * DAY_IN_LEDGERS;

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfferCreated {
    #[topic]
    pub offer_id: u64,
    #[topic]
    pub maker: Address,
    pub token: Address,
    pub amount: i128,
    pub sats_per_token: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfferCancelled {
    #[topic]
    pub offer_id: u64,
    pub refunded: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TradeOpened {
    #[topic]
    pub trade_id: u64,
    #[topic]
    pub offer_id: u64,
    #[topic]
    pub taker: Address,
    pub amount: i128,
    pub sats_due: u64,
    pub deadline: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TradeSettled {
    #[topic]
    pub trade_id: u64,
    #[topic]
    pub offer_id: u64,
    /// Bitcoin txid, internal byte order.
    #[topic]
    pub btc_txid: BytesN<32>,
    pub taker: Address,
    pub amount: i128,
    pub fee: i128,
    pub sats_paid: u64,
    pub btc_block_height: u32,
    pub confirmations: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TradeExpired {
    #[topic]
    pub trade_id: u64,
    #[topic]
    pub offer_id: u64,
    pub bond_to_maker: i128,
}

#[contract]
pub struct BitGateEscrow;

#[contractimpl]
impl BitGateEscrow {
    /// Runs once, atomically, at deployment. `spv` is the Writz
    /// `bitcoin-spv` contract (testnet:
    /// `CBX23YKCCJMAMBMSCNP6YVKEXUIYK2CTKSR4TQ3RVBPAFYZFVCW7W4EO`).
    pub fn __constructor(env: Env, admin: Address, spv: Address, treasury: Address, fee_bps: u32) {
        if fee_bps > MAX_FEE_BPS {
            soroban_sdk::panic_with_error!(&env, Error::InvalidFee);
        }
        env.storage().instance().set(
            &DataKey::Config,
            &Config {
                admin,
                spv,
                treasury,
                fee_bps,
            },
        );
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    /// Sets the protocol fee and where it goes. Admin only. Applies to trades
    /// settled after the change.
    pub fn set_fee(env: Env, fee_bps: u32, treasury: Address) -> Result<(), Error> {
        let mut config = config(&env);
        config.admin.require_auth();
        if fee_bps > MAX_FEE_BPS {
            return Err(Error::InvalidFee);
        }
        config.fee_bps = fee_bps;
        config.treasury = treasury;
        save_config(&env, &config);
        Ok(())
    }

    /// Points the escrow at another `bitcoin-spv` deployment. Admin only.
    /// Writz never upgrades its contracts in place: a new light client gets
    /// a new contract ID, and this is how BitGate follows it.
    pub fn set_spv(env: Env, spv: Address) {
        let mut config = config(&env);
        config.admin.require_auth();
        config.spv = spv;
        save_config(&env, &config);
    }

    /// Hands the admin role to `new_admin`. Both must sign, so the role cannot
    /// be sent to an address nobody controls.
    pub fn set_admin(env: Env, new_admin: Address) {
        let mut config = config(&env);
        config.admin.require_auth();
        new_admin.require_auth();
        config.admin = new_admin;
        save_config(&env, &config);
    }

    /// Sends the protocol fees accrued in `token` to the treasury and returns
    /// the amount. Admin only.
    pub fn withdraw_fees(env: Env, token: Address) -> i128 {
        let config = config(&env);
        config.admin.require_auth();
        let key = DataKey::Fees(token.clone());
        let accrued: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if accrued > 0 {
            env.storage().persistent().set(&key, &0i128);
            token::TokenClient::new(&env, &token).transfer(
                &env.current_contract_address(),
                &config.treasury,
                &accrued,
            );
        }
        accrued
    }

    // ── Maker ────────────────────────────────────────────────────────────────

    /// Locks `amount` of `token` from `maker` in a new offer and returns its id.
    ///
    /// - `btc_script_pubkey`: where the maker wants the Bitcoin. Use a fresh
    ///   address per offer: any payment to it above a trade's height floor
    ///   counts for that trade.
    /// - `sats_per_token`: price in satoshis per whole token.
    /// - `min_fill`: smallest fill in base units.
    /// - `min_confirmations`: depth a payment needs, 1 to 144.
    /// - `window_secs`: time a taker has to pay and claim.
    /// - `bond_bps`: taker bond, paid to the maker if the taker does not pay.
    #[allow(clippy::too_many_arguments)]
    pub fn create_offer(
        env: Env,
        maker: Address,
        token: Address,
        amount: i128,
        btc_script_pubkey: Bytes,
        sats_per_token: u64,
        min_fill: i128,
        min_confirmations: u32,
        window_secs: u64,
        bond_bps: u32,
    ) -> Result<u64, Error> {
        maker.require_auth();

        if amount <= 0 || min_fill <= 0 || min_fill > amount {
            return Err(Error::InvalidAmount);
        }
        if sats_per_token == 0 {
            return Err(Error::InvalidPrice);
        }
        if btc_script_pubkey.is_empty() || btc_script_pubkey.len() > MAX_SCRIPT_LEN {
            return Err(Error::InvalidScript);
        }
        if min_confirmations == 0 || min_confirmations > MAX_CONFIRMATIONS {
            return Err(Error::InvalidConfirmations);
        }
        if !(MIN_WINDOW_SECS..=MAX_WINDOW_SECS).contains(&window_secs) {
            return Err(Error::InvalidWindow);
        }
        if bond_bps > MAX_BOND_BPS {
            return Err(Error::InvalidBond);
        }

        let token_client = token::TokenClient::new(&env, &token);
        let unit = 10i128
            .checked_pow(token_client.decimals())
            .ok_or(Error::Overflow)?;
        // Every fill, including the smallest, must be payable on Bitcoin.
        if sats_for(min_fill, sats_per_token, unit)? < DUST_SATS {
            return Err(Error::BelowDust);
        }

        let id = next_id(&env, &DataKey::OfferCount);
        let offer = Offer {
            id,
            maker: maker.clone(),
            token: token.clone(),
            unit,
            btc_script_pubkey,
            sats_per_token,
            remaining: amount,
            min_fill,
            min_confirmations,
            window_secs,
            bond_bps,
            active_trade: None,
            filled: 0,
            cancelled: false,
        };
        save_offer(&env, &offer);

        token_client.transfer(&maker, env.current_contract_address(), &amount);

        OfferCreated {
            offer_id: id,
            maker,
            token,
            amount,
            sats_per_token,
        }
        .publish(&env);
        Ok(id)
    }

    /// Withdraws everything the offer has not reserved and closes it. Maker
    /// only. A reservation already open stays valid: its taker can still
    /// claim, and if it expires its tokens go straight back to the maker.
    pub fn cancel_offer(env: Env, offer_id: u64) -> Result<i128, Error> {
        let mut offer = load_offer(&env, offer_id)?;
        offer.maker.require_auth();
        if offer.cancelled {
            return Err(Error::OfferClosed);
        }

        let refunded = offer.remaining;
        offer.remaining = 0;
        offer.cancelled = true;
        save_offer(&env, &offer);

        if refunded > 0 {
            token::TokenClient::new(&env, &offer.token).transfer(
                &env.current_contract_address(),
                &offer.maker,
                &refunded,
            );
        }

        OfferCancelled { offer_id, refunded }.publish(&env);
        Ok(refunded)
    }

    // ── Taker ────────────────────────────────────────────────────────────────

    /// Reserves `amount` of an offer for `taker` and returns the trade id.
    ///
    /// The taker locks the offer's bond and then has `window_secs` to pay
    /// `sats_due` to the offer's scriptPubKey and get it proven with `claim`.
    /// The light client tip is recorded now: only a payment mined above it can
    /// settle this trade.
    ///
    /// `amount` must be at least the offer's `min_fill`, unless it takes
    /// everything that remains.
    pub fn take(env: Env, offer_id: u64, taker: Address, amount: i128) -> Result<u64, Error> {
        taker.require_auth();

        let mut offer = load_offer(&env, offer_id)?;
        if taker == offer.maker {
            return Err(Error::SelfTrade);
        }

        // A lapsed reservation does not block the offer: expire it first.
        if let Some(active) = offer.active_trade {
            let trade = load_trade(&env, active)?;
            if env.ledger().timestamp() <= trade.deadline {
                return Err(Error::OfferBusy);
            }
            expire_trade(&env, &mut offer, trade);
        }

        if offer.cancelled || offer.remaining == 0 {
            return Err(Error::OfferClosed);
        }
        if amount <= 0
            || amount > offer.remaining
            || (amount < offer.min_fill && amount != offer.remaining)
        {
            return Err(Error::InvalidAmount);
        }

        let sats_due = sats_for(amount, offer.sats_per_token, offer.unit)?;
        if sats_due < DUST_SATS {
            return Err(Error::BelowDust);
        }
        let bond = bps_of(amount, offer.bond_bps)?;

        let spv = BitcoinSpvClient::new(&env, &config(&env).spv);
        let floor = spv
            .get_best_tip()
            .ok_or(Error::LightClientUnavailable)?
            .height;

        let now = env.ledger().timestamp();
        let id = next_id(&env, &DataKey::TradeCount);
        let trade = Trade {
            id,
            offer_id,
            taker: taker.clone(),
            amount,
            sats_due,
            bond,
            btc_height_floor: floor,
            opened_at: now,
            deadline: now + offer.window_secs,
            status: TradeStatus::Pending,
            btc_txid: None,
            btc_block_height: None,
            sats_paid: None,
            fee: 0,
        };
        offer.remaining -= amount;
        offer.active_trade = Some(id);
        save_offer(&env, &offer);
        save_trade(&env, &trade);

        if bond > 0 {
            token::TokenClient::new(&env, &offer.token).transfer(
                &taker,
                env.current_contract_address(),
                &bond,
            );
        }

        TradeOpened {
            trade_id: id,
            offer_id,
            taker,
            amount,
            sats_due,
            deadline: trade.deadline,
        }
        .publish(&env);
        Ok(id)
    }

    /// Settles a trade with a Bitcoin SPV proof and releases the tokens and
    /// the bond to the taker.
    ///
    /// The five proof arguments are exactly `sorobanArgs` from the Writz
    /// relayer (`GET /spv-proof/:txid`), or the same values built from any
    /// Esplora API. Anyone may submit the proof: the tokens always go to the
    /// trade's taker, so there is nothing to gain by front-running it.
    pub fn claim(
        env: Env,
        trade_id: u64,
        block_hash: BytesN<32>,
        merkle_proof: Vec<BytesN<32>>,
        tx_index: u32,
        raw_tx: Bytes,
    ) -> Result<Trade, Error> {
        let mut trade = load_trade(&env, trade_id)?;
        if trade.status != TradeStatus::Pending {
            return Err(Error::TradeNotPending);
        }
        if env.ledger().timestamp() > trade.deadline {
            return Err(Error::TradeExpired);
        }
        let mut offer = load_offer(&env, trade.offer_id)?;
        let config = config(&env);

        // 1. Inclusion and depth, proven by the Writz light client. `try_`
        //    returns its error as a value, so the reason reaches the caller
        //    as one of BitGate's own codes instead of a bare failure.
        let proof = match BitcoinSpvClient::new(&env, &config.spv).try_verify_transaction(
            &block_hash,
            &merkle_proof,
            &tx_index,
            &raw_tx,
            &offer.min_confirmations,
        ) {
            Ok(Ok(result)) => result,
            Err(Ok(SPVError::InsufficientConfirmations)) => {
                return Err(Error::NotEnoughConfirmations)
            }
            Err(Ok(SPVError::HeaderNotFound)) => return Err(Error::BlockNotInLightClient),
            _ => return Err(Error::ProofRejected),
        };

        // 2. Freshness: the payment must be newer than the trade.
        if proof.block_height <= trade.btc_height_floor {
            return Err(Error::PaymentPredatesTrade);
        }

        // 3. Replay: one trade per Bitcoin transaction, across all offers.
        let used_key = DataKey::UsedTxid(proof.txid.clone());
        if env.storage().persistent().has(&used_key) {
            return Err(Error::TxidAlreadyUsed);
        }

        // 4. Recipient and amount: parsed on chain from the proven bytes.
        let sats_paid =
            find_output_value(&raw_tx, &offer.btc_script_pubkey).ok_or(Error::OutputNotFound)?;
        if sats_paid < trade.sats_due {
            return Err(Error::Underpaid);
        }

        // Effects before transfers.
        let fee = bps_of(trade.amount, config.fee_bps)?;
        trade.status = TradeStatus::Settled;
        trade.btc_txid = Some(proof.txid.clone());
        trade.btc_block_height = Some(proof.block_height);
        trade.sats_paid = Some(sats_paid);
        trade.fee = fee;
        save_trade(&env, &trade);

        offer.filled += trade.amount;
        offer.active_trade = None;
        save_offer(&env, &offer);

        env.storage().persistent().set(&used_key, &trade_id);
        bump_persistent(&env, &used_key);

        record(&env, &offer.maker, |r| {
            r.settled_as_maker += 1;
            r.volume += trade.amount;
        });
        record(&env, &trade.taker, |r| {
            r.settled_as_taker += 1;
            r.volume += trade.amount;
        });

        // The fee stays in the escrow until `withdraw_fees`: a treasury that
        // cannot receive the token (no trustline, frozen) must never block a
        // taker's settlement.
        if fee > 0 {
            let fees_key = DataKey::Fees(offer.token.clone());
            let accrued: i128 = env.storage().persistent().get(&fees_key).unwrap_or(0);
            env.storage().persistent().set(&fees_key, &(accrued + fee));
            bump_persistent(&env, &fees_key);
        }

        token::TokenClient::new(&env, &offer.token).transfer(
            &env.current_contract_address(),
            &trade.taker,
            &(trade.amount - fee + trade.bond),
        );

        TradeSettled {
            trade_id,
            offer_id: offer.id,
            btc_txid: proof.txid,
            taker: trade.taker.clone(),
            amount: trade.amount,
            fee,
            sats_paid,
            btc_block_height: proof.block_height,
            confirmations: proof.confirmations,
        }
        .publish(&env);
        Ok(trade)
    }

    /// Ends a reservation whose deadline has passed. Anyone may call it. The
    /// tokens go back to the offer (or to the maker if the offer was
    /// cancelled) and the taker's bond goes to the maker.
    pub fn expire(env: Env, trade_id: u64) -> Result<Trade, Error> {
        let trade = load_trade(&env, trade_id)?;
        if trade.status != TradeStatus::Pending {
            return Err(Error::TradeNotPending);
        }
        if env.ledger().timestamp() <= trade.deadline {
            return Err(Error::TradeNotExpired);
        }
        let mut offer = load_offer(&env, trade.offer_id)?;
        let trade = expire_trade(&env, &mut offer, trade);
        save_offer(&env, &offer);
        Ok(trade)
    }

    // ── Reads ────────────────────────────────────────────────────────────────

    pub fn get_config(env: Env) -> Config {
        config(&env)
    }

    pub fn get_offer(env: Env, offer_id: u64) -> Result<Offer, Error> {
        load_offer(&env, offer_id)
    }

    pub fn get_trade(env: Env, trade_id: u64) -> Result<Trade, Error> {
        load_trade(&env, trade_id)
    }

    /// Number of offers ever created. Offer ids run from 1 to this value.
    pub fn offer_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::OfferCount)
            .unwrap_or(0)
    }

    /// Number of trades ever opened. Trade ids run from 1 to this value.
    pub fn trade_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::TradeCount)
            .unwrap_or(0)
    }

    /// Satoshis a taker would owe for `amount` of an offer.
    pub fn quote(env: Env, offer_id: u64, amount: i128) -> Result<u64, Error> {
        let offer = load_offer(&env, offer_id)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        sats_for(amount, offer.sats_per_token, offer.unit)
    }

    /// The trade a Bitcoin txid (internal byte order) settled, if any.
    pub fn trade_for_txid(env: Env, btc_txid: BytesN<32>) -> Option<u64> {
        env.storage().persistent().get(&DataKey::UsedTxid(btc_txid))
    }

    /// Protocol fees accrued in `token` and not yet withdrawn.
    pub fn accrued_fees(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Fees(token))
            .unwrap_or(0)
    }

    pub fn get_reputation(env: Env, address: Address) -> Reputation {
        env.storage()
            .persistent()
            .get(&DataKey::Reputation(address))
            .unwrap_or_default()
    }
}

// ── Internal ─────────────────────────────────────────────────────────────────

/// Satoshis owed for `amount` base units at `sats_per_token`, rounded up so
/// the maker is never paid less than the price.
fn sats_for(amount: i128, sats_per_token: u64, unit: i128) -> Result<u64, Error> {
    let product = amount
        .checked_mul(sats_per_token as i128)
        .ok_or(Error::Overflow)?;
    let sats = product.checked_add(unit - 1).ok_or(Error::Overflow)? / unit;
    u64::try_from(sats).map_err(|_| Error::Overflow)
}

fn bps_of(amount: i128, bps: u32) -> Result<i128, Error> {
    Ok(amount.checked_mul(bps as i128).ok_or(Error::Overflow)? / BPS)
}

/// Marks a lapsed trade expired, returns its tokens and pays the bond to the
/// maker. The caller saves `offer`.
fn expire_trade(env: &Env, offer: &mut Offer, mut trade: Trade) -> Trade {
    trade.status = TradeStatus::Expired;
    save_trade(env, &trade);

    offer.active_trade = None;
    let token_client = token::TokenClient::new(env, &offer.token);
    let escrow = env.current_contract_address();
    if offer.cancelled {
        token_client.transfer(&escrow, &offer.maker, &trade.amount);
    } else {
        offer.remaining += trade.amount;
    }
    if trade.bond > 0 {
        token_client.transfer(&escrow, &offer.maker, &trade.bond);
    }

    record(env, &trade.taker, |r| r.expired_as_taker += 1);

    TradeExpired {
        trade_id: trade.id,
        offer_id: offer.id,
        bond_to_maker: trade.bond,
    }
    .publish(env);
    trade
}

fn config(env: &Env) -> Config {
    let storage = env.storage().instance();
    storage.extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
    storage.get(&DataKey::Config).unwrap()
}

fn save_config(env: &Env, config: &Config) {
    env.storage().instance().set(&DataKey::Config, config);
}

fn next_id(env: &Env, key: &DataKey) -> u64 {
    let id: u64 = env.storage().instance().get(key).unwrap_or(0) + 1;
    env.storage().instance().set(key, &id);
    id
}

fn load_offer(env: &Env, id: u64) -> Result<Offer, Error> {
    let key = DataKey::Offer(id);
    let offer = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::OfferNotFound)?;
    bump_persistent(env, &key);
    Ok(offer)
}

fn save_offer(env: &Env, offer: &Offer) {
    let key = DataKey::Offer(offer.id);
    env.storage().persistent().set(&key, offer);
    bump_persistent(env, &key);
}

fn load_trade(env: &Env, id: u64) -> Result<Trade, Error> {
    let key = DataKey::Trade(id);
    let trade = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::TradeNotFound)?;
    bump_persistent(env, &key);
    Ok(trade)
}

fn save_trade(env: &Env, trade: &Trade) {
    let key = DataKey::Trade(trade.id);
    env.storage().persistent().set(&key, trade);
    bump_persistent(env, &key);
}

fn record(env: &Env, address: &Address, update: impl FnOnce(&mut Reputation)) {
    let key = DataKey::Reputation(address.clone());
    let mut reputation: Reputation = env.storage().persistent().get(&key).unwrap_or_default();
    update(&mut reputation);
    env.storage().persistent().set(&key, &reputation);
    bump_persistent(env, &key);
}

fn bump_persistent(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_THRESHOLD, PERSISTENT_BUMP);
}
