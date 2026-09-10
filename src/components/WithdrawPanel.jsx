import React, { useCallback, useEffect, useState } from 'react';
import { ClutchHubSdk } from 'clutch-hub-sdk-js';
import { API_URL, CHAIN_ID, ORCHESTRATOR_BASE_URL } from '../config';
import TransactionHistory from './TransactionHistory';
import { CopyableValue } from './DepositPanel';
import { usePrivateKeyRequest } from './layout/usePrivateKeyRequest.jsx';
import { useConfirmDialog } from './layout/useConfirmDialog.jsx';
import { formatExactUsdt, parseUsdToClt } from '../utils/money';

/** Per the status table in
 * `clutch-treasury/docs/superpowers/specs/2026-09-04-redemption-panel-design.md` — the orchestrator
 * keeps returning the raw treasury status; this is where (and only where) it becomes a word a user
 * reads. `payout_pending` and `payout_submitted` deliberately share wording: the distinction
 * matters to an operator, not to someone waiting for money. A status not listed here renders as
 * its own raw string rather than guessing a label. */
const REDEMPTION_STATUS_LABELS = {
  created: 'Awaiting your burn',
  burn_confirmed: 'Burn confirmed',
  payout_pending: 'Sending USDT',
  payout_submitted: 'Sending USDT',
  paid: 'Paid',
  expired: 'Needs review',
  failed: 'Needs review',
  // Not a treasury status — set by this client alone when the status route 404s (see the poller).
  gone: 'No longer found',
};

/** The orchestrator has no "list my redemptions" route — only `POST /api/v1/redemptions` and
 * `GET /api/v1/redemptions/:id`. So the id of an in-progress redemption has to survive a closed
 * tab locally or it is unrecoverable from this app, which is exactly the "created, then the user
 * closed the tab" case the design requires the panel to survive. Same `clutch_*_<publicKey>`
 * shape as the local tx log (`clutch_tx_<publicKey>`). One in-progress redemption per wallet. */
const storageKey = (publicKey) => `clutch_redemption_${publicKey}`;

function loadRedemption(publicKey) {
  if (!publicKey) return null;
  try {
    const raw = window.localStorage.getItem(storageKey(publicKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // A record without a server-issued id AND ref is useless: it can neither be polled nor burned
    // against. Dropping it beats rendering half a redemption.
    return parsed && parsed.id && parsed.redemptionRef ? parsed : null;
  } catch {
    return null;
  }
}

function saveRedemption(publicKey, record) {
  if (!publicKey) return;
  try {
    if (record) window.localStorage.setItem(storageKey(publicKey), JSON.stringify(record));
    else window.localStorage.removeItem(storageKey(publicKey));
  } catch {
    // Private mode / quota. The in-memory record still drives this session; only recovery after a
    // reload is lost, and it is better than failing the withdrawal over a storage error.
  }
}

/** Same defensive shape as `formatDepositAmount` in `DepositPanel.jsx`, for the same reason:
 * `formatExactUsdt` throws on anything it cannot read as a non-negative integer, and this app has
 * no error boundary, so one bad stored value would blank the whole panel. Trailing zeros are
 * trimmed to a minimum of two decimals — lossless, since only zeros are removed.
 *
 * `formatExactUsdt` and not `formatUsd`, for the same reason the deposit amount uses it:
 * `formatUsd` FLOORS to cents, and a burn amount has to display exactly — this number is what
 * gets destroyed. Both read the same 1e6 scale (`formatUsd` divides by 10,000 to cents and then
 * by 100 to dollars), which is the scale `parseUsdToClt` produces and the scale the
 * orchestrator's own bounds are written in (`min_redemption_clt = 10000000`, i.e. 10 CLT). */
function formatCltAmount(baseUnits) {
  try {
    const [whole, frac] = formatExactUsdt(baseUnits).split('.');
    return `${whole}.${frac.replace(/0+$/, '').padEnd(2, '0')}`;
  } catch {
    return '—';
  }
}

/** What actually arrives, in base units, as a string.
 *
 * The treasury quotes two numbers: the CLT to burn and the USDT that will be paid after its
 * redemption fee. They are equal only where no fee is configured. Falls back to the burn amount
 * because a record stored before this app knew about fees has no net on it, and because an
 * orchestrator too old to send one is by definition charging nothing — in both cases par is the
 * true answer, not a guess.
 */
function netOf(record) {
  return record?.payoutAmountUsdt ?? record?.amountClt;
}

/** The fee as base units, or `0n` when there is none to show. */
function feeOf(record) {
  try {
    return BigInt(record.amountClt) - BigInt(netOf(record));
  } catch {
    return 0n;
  }
}

/**
 * "Withdraw to USDT": burn CLT, get USDT back at a Tron address the user names.
 *
 * The mirror image of `DepositPanel`, with one difference that drives every decision in here: a
 * burn is irreversible and it happens BEFORE the payout. A deposit that goes wrong leaves money
 * sitting at an address someone can sweep later; a redemption that goes wrong has already
 * destroyed the user's CLT.
 *
 * So the order is fixed and not negotiable:
 *   1. `POST /api/v1/redemptions` → `{id, redemption_ref, amount_clt, status}`
 *   2. `sdk.createUnsignedBurn({ amount, redemptionRef })` with the ref from step 1
 *   3. `sdk.signTransaction` (local, as everywhere else in this app) with an `expected` blob, so
 *      the hub's answer is verified against what we asked for instead of signed blind
 *   4. `sdk.submitTransaction`
 *   5. poll `GET /api/v1/redemptions/:id`
 *
 * A burn carrying no ref is CLT destroyed with nothing on the treasury side pointing at it, so
 * `handleBurn` is reachable only from a record that came back from step 1, and it refuses to run
 * without `redemptionRef`. A SECOND burn against one ref is just as bad — the treasury pays a ref
 * once — so `burnAttempted` is written to localStorage before the broadcast, never only to state.
 */
const WithdrawPanel = ({ userProfile, open }) => {
  const [redemption, setRedemption] = useState(null);
  const [payoutAddress, setPayoutAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [unavailable, setUnavailable] = useState(false);

  const { PrivateKeyModal, requestPrivateKey } = usePrivateKeyRequest();
  const { ConfirmModal, requestConfirm } = useConfirmDialog();

  const publicKey = userProfile?.publicKey || '';
  const privateKey = userProfile?.privateKey || '';
  const redemptionId = redemption?.id || null;

  /** An SDK plus the key it was built with — `signTransaction` needs the raw key too, and asking
   * for it twice would mean two modals for one burn. Built the same way `DepositPanel` builds
   * its own (constructor takes the key, so no `setPrivateKey` call is needed before
   * `createUnsigned*`). Returns null when the user dismisses the key modal. */
  const openSession = useCallback(async () => {
    if (!publicKey) return null;
    let pk = privateKey;
    if (!pk) {
      pk = await requestPrivateKey('Enter your private key to continue this withdrawal:');
      if (!pk) return null;
    }
    return { sdk: new ClutchHubSdk(API_URL, publicKey, pk, CHAIN_ID), privateKey: pk };
  }, [publicKey, privateKey, requestPrivateKey]);

  // Re-read the in-progress redemption from storage whenever the wallet changes or the panel is
  // toggled. Reopening is the moment to pick up a redemption left behind by a closed tab, and it
  // is also where transient banners should clear — the same "a reopen refetches" behaviour the
  // deposit panel has. It cannot clobber a redemption created seconds ago, because every handler
  // writes to storage BEFORE it writes to state.
  useEffect(() => {
    setRedemption(loadRedemption(publicKey));
    setError(null);
    setUnavailable(false);
  }, [publicKey, open]);

  // Poll the redemption's status while the panel is open. Shape copied from `DepositPanel`'s
  // deposit-list poller, including the parts that look redundant and are not: the in-flight guard
  // (a slow response must not be overwritten by a newer one) and the `cancelled` re-check after
  // EVERY await. `WithdrawPanel` is permanently mounted by `OverlayPanel` (hidden via CSS, never
  // unmounted — see App.jsx), so arming the interval without re-checking `cancelled` would leak a
  // timer holding a private-key-bearing SDK for the life of the tab. A failed poll is logged and
  // otherwise ignored: it must never clobber the record already on screen, and a status that
  // cannot be read is not a status that changed.
  useEffect(() => {
    if (!open || !redemptionId || !publicKey) return undefined;

    let cancelled = false;
    let intervalId = null;
    let fetching = false; // in-flight guard

    const fetchStatus = async (sdk) => {
      if (fetching) return;
      fetching = true;
      try {
        const authHeaders = await sdk.getAuthHeaders();
        if (cancelled) return;
        const res = await fetch(`${ORCHESTRATOR_BASE_URL}/api/v1/redemptions/${redemptionId}`, {
          method: 'GET',
          headers: authHeaders,
        });
        // 404 is the one non-2xx that must not be swallowed. The orchestrator answers it when the
        // mapping row is gone — which is what an orchestrator DB reset looks like, and stage gets
        // those. Swallowed, the record sits at `created` forever and the panel keeps offering a
        // burn against a ref no intent exists for. Kept in state only, not written to storage: a
        // reload should re-ask rather than remember a verdict this client invented.
        if (res.status === 404) {
          setRedemption((prev) =>
            prev && prev.id === redemptionId && prev.status !== 'gone'
              ? { ...prev, status: 'gone' }
              : prev
          );
          return;
        }
        if (!res.ok) throw new Error(`redemption status failed (${res.status})`);
        const body = await res.json();
        // `status_live: false` means the orchestrator could not reach the treasury and fell back to
        // the status stored at creation time — which is always `created`, because only the treasury
        // watcher advances a redemption. Writing that back would downgrade a live `payout_pending`
        // to `created` and put "Nothing has been burned yet — your CLT is untouched" on screen over
        // destroyed money. The orchestrator returns the flag precisely so a client can tell "not
        // yet" from "we couldn't ask"; a status we couldn't ask for is not a status that changed.
        if (cancelled || !body.status || body.status_live === false) return;
        setRedemption((prev) =>
          prev && prev.id === redemptionId ? { ...prev, status: body.status } : prev
        );
        const stored = loadRedemption(publicKey);
        if (stored && stored.id === redemptionId && stored.status !== body.status) {
          saveRedemption(publicKey, { ...stored, status: body.status });
        }
      } catch (err) {
        console.error('redemption status fetch failed', err);
      } finally {
        fetching = false;
      }
    };

    (async () => {
      const session = await openSession();
      if (cancelled || !session) return;
      await fetchStatus(session.sdk);
      if (!cancelled) intervalId = setInterval(() => fetchStatus(session.sdk), 10000);
    })();

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [open, redemptionId, publicKey, openSession]);

  // Step 1, and nothing else. This creates the redemption and stops; it never burns. The two are
  // separate user actions on purpose, so that the ref always exists before the burn is offered.
  const handleCreate = useCallback(
    async (event) => {
      event.preventDefault();
      setError(null);
      setUnavailable(false);

      const to = payoutAddress.trim();
      if (!to) {
        setError('Enter the Tron address that should receive the USDT.');
        return;
      }
      let amountClt;
      try {
        amountClt = parseUsdToClt(amount);
      } catch {
        setError('Enter an amount like 5 or 5.25.');
        return;
      }
      if (amountClt <= 0n) {
        setError('Enter an amount greater than zero.');
        return;
      }
      // No min/max check here on purpose. The bounds are server config
      // (`min_redemption_clt`/`max_redemption_clt`); a limit duplicated in the client is a limit
      // that will drift, so the server's own "amount_clt must be between {min} and {max}" is what
      // the user sees.

      setBusy(true);
      try {
        const session = await openSession();
        if (!session) {
          setError('Cancelled — no withdrawal was started.');
          return;
        }
        const authHeaders = await session.sdk.getAuthHeaders();
        const res = await fetch(`${ORCHESTRATOR_BASE_URL}/api/v1/redemptions`, {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          // ponytail: `Number()` on a money bigint, which `utils/money.js` otherwise bans. The
          // orchestrator's `amount_clt` is a JSON number (i64 server-side) and a string there is a
          // 400, so the wire format is not ours to change here. Ceiling: exact only below 2^53;
          // today's `max_redemption_clt` is 50 CLT (5e7), eight orders of magnitude under it, and
          // the server re-checks its own bounds either way. Upgrade path: teach the orchestrator to
          // accept a decimal string, as the hub already does for `fare`, then send `.toString()`.
          body: JSON.stringify({ payout_tron_address: to, amount_clt: Number(amountClt) }),
        });
        if (res.status === 503) {
          setUnavailable(true);
          return;
        }
        // `.catch` because a 502 from nginx is an HTML page, and "Unexpected token '<'" is a
        // worse thing to show someone than the status-coded fallback below.
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `withdrawal request failed (${res.status})`);
        if (!body.id || !body.redemption_ref) {
          throw new Error('the withdrawal service returned no reference — nothing was burned');
        }
        const record = {
          id: body.id,
          redemptionRef: body.redemption_ref,
          amountClt: String(body.amount_clt ?? amountClt),
          // The server's quote for the USDT leg, stored rather than recomputed here: the treasury
          // fixes it at creation precisely so it cannot move between what the user is shown and
          // what they are paid, and recomputing it client-side would throw that guarantee away.
          payoutAmountUsdt: String(body.payout_amount_usdt ?? body.amount_clt ?? amountClt),
          payoutAddress: to,
          status: body.status || 'created',
          burnAttempted: false,
        };
        saveRedemption(publicKey, record);
        setRedemption(record);
        setPayoutAddress('');
        setAmount('');
      } catch (err) {
        console.error('redemption create failed', err);
        setError(err.message || 'Could not start the withdrawal.');
      } finally {
        setBusy(false);
      }
    },
    [amount, openSession, payoutAddress, publicKey]
  );

  // Steps 2-4. Reachable only with a redemption record in hand, and it re-checks that record
  // itself rather than trusting the button's `disabled`: this is the one action in this app that
  // destroys something.
  const handleBurn = useCallback(async () => {
    // The load-bearing guard. `redemptionRef` only ever comes from a 201 in `handleCreate`, so
    // there is no path from this component to `createUnsignedBurn` without a server-issued ref.
    if (!redemption?.redemptionRef) return;
    // And the second one: a burn is offered at most once per redemption. A second burn against a
    // ref the treasury has already matched is CLT destroyed for a payout that will not happen
    // twice.
    if (redemption.burnAttempted || redemption.status !== 'created') return;

    setError(null);
    const amountLabel = formatCltAmount(redemption.amountClt);
    const netLabel = formatCltAmount(netOf(redemption));
    const fee = feeOf(redemption);
    // Naming the net here is not a nicety. The burn is irreversible and happens before the payout,
    // so this dialog is the last moment a user can decline — and a fee they only discover
    // afterwards is one they never agreed to.
    const feeSentence =
      fee > 0n ? ` A withdrawal fee of ${formatCltAmount(fee.toString())} USDT is deducted.` : '';
    const confirmed = await requestConfirm({
      title: `Burn ${amountLabel} CLT?`,
      // Address in full, never truncated — the same reasoning as the deposit address: an address
      // you cannot read in full is one you cannot check.
      desc:
        `${amountLabel} CLT will be destroyed and ${netLabel} USDT sent to ` +
        `${redemption.payoutAddress}.${feeSentence} ` +
        'A burn cannot be undone and the address cannot be changed afterwards.',
      confirmText: 'Burn and withdraw',
      cancelText: 'Keep my CLT',
    });
    if (!confirmed) return;

    // The guards above read `redemption` — the closure from the render that drew the button. The
    // confirm dialog is an UNBOUNDED await, and `openSession` (possibly another modal) plus a
    // network round trip follow it, so by the time the burn happens that closure can be minutes
    // stale: a second tab on the same wallet, or this dialog answered after lunch, both reach a
    // second burn otherwise. Everything downstream uses `current`, never `redemption`.
    //
    // ponytail: read-then-write, not atomic across tabs — nothing in localStorage can be. It
    // narrows a multi-minute window to the gap between this read and the `burnAttempted` write
    // below. A cross-tab lock would need a Web Lock or a server-side claim; the treasury already
    // refuses to pay one ref twice, which is the bound that actually protects the money.
    const current = loadRedemption(publicKey);
    // The id check is not redundant with the status checks: if storage now holds a DIFFERENT
    // redemption, burning it would spend a confirmation the user gave for another amount and
    // another address.
    if (
      !current?.redemptionRef ||
      current.id !== redemption.id ||
      current.burnAttempted ||
      current.status !== 'created'
    ) {
      setError('This withdrawal has already moved on — reopen the panel to see its status.');
      return;
    }

    setBusy(true);
    let broadcastAttempted = false;
    try {
      const session = await openSession();
      if (!session) {
        setError('Cancelled — nothing was burned.');
        return;
      }
      const unsignedTx = await session.sdk.createUnsignedBurn({
        amount: BigInt(current.amountClt),
        redemptionRef: current.redemptionRef,
      });
      // Never blind-sign the burn. The hub builds this blob and the hub is the untrusted party in
      // this design — that is the whole reason the key stays here. `verifyUnsignedTransaction`
      // pins the amount and the ref against what WE asked for, plus `from` and `chain_id`, which
      // `signTransaction` fills in from this SDK instance. A wrong amount or a dropped ref would
      // otherwise get signed unread, and a ref-less burn is CLT destroyed with nothing on the
      // treasury side pointing at it. It throws before signing, while `broadcastAttempted` is
      // still false, so the "Nothing was burned" branch below is the one that runs.
      const signature = await session.sdk.signTransaction(unsignedTx, session.privateKey, {
        type: 'Burn',
        amount: BigInt(current.amountClt),
        redemptionRef: current.redemptionRef,
      });

      // Written BEFORE the broadcast, and to storage rather than only to state. A lost response, a
      // crash, or a reload must never bring the burn button back for this reference.
      broadcastAttempted = true;
      const attempted = { ...current, burnAttempted: true };
      saveRedemption(publicKey, attempted);
      setRedemption(attempted);

      await session.sdk.submitTransaction(signature.rawTransaction);
      // In a try of its own: the burn succeeded, and a localStorage failure here (private mode,
      // quota) must not fall into the catch below and tell the user their burn "did not get a
      // clean answer back". Losing a history row is not losing money.
      try {
        TransactionHistory.addTransaction(publicKey, {
          type: 'Withdraw burn',
          timestamp: Date.now(),
          fare: String(current.amountClt),
          status: 'success',
          txHash: signature.txHash || '',
        });
      } catch (logErr) {
        console.error('withdraw burn history write failed', logErr);
      }
    } catch (err) {
      console.error('redemption burn failed', err);
      setError(
        broadcastAttempted
          ? `Your burn was sent but this app did not get a clean answer back (${err.message || 'unknown error'}). ` +
            'Your CLT may already be burned, so the burn will not be offered again. The withdrawal ' +
            'is tracked below under its reference — nothing is unaccounted for; if the status stays ' +
            'stuck, send support that reference.'
          : `Could not prepare the burn (${err.message || 'unknown error'}). Nothing was burned — you can try again.`
      );
    } finally {
      setBusy(false);
    }
  }, [openSession, publicKey, redemption, requestConfirm]);

  // Never offered while the burn is still on the table (see `canStartAnother`), so it can never be
  // the "create a second redemption for the same intent" mistake. It clears local tracking only —
  // the redemption itself keeps existing treasury-side, which is why the reference above is
  // copyable and the caption says to keep it.
  //
  // Behind a confirm because it IS reachable while a burn is confirming (`awaitingBurn`), and this
  // app has no "list my redemptions" route: one click deletes the only copy of the id and the ref
  // for an irreversible burn that is already in flight.
  const handleStartAnother = useCallback(async () => {
    const confirmed = await requestConfirm({
      title: 'Stop tracking this withdrawal?',
      desc:
        'This clears it from this device only — the withdrawal keeps running at the treasury. ' +
        'The reference is the only way to look it up afterwards, so copy it first.',
      confirmText: 'Clear it from this device',
      cancelText: 'Keep tracking it',
    });
    if (!confirmed) return;
    saveRedemption(publicKey, null);
    setRedemption(null);
    setError(null);
  }, [publicKey, requestConfirm]);

  const status = redemption?.status || '';
  const canBurn = !!redemption && !redemption.burnAttempted && status === 'created';
  const awaitingBurn = !!redemption && redemption.burnAttempted && status === 'created';
  const needsReview = status === 'failed' || status === 'expired';
  const canStartAnother = !!redemption && !canBurn;

  return (
    <div className="card">
      <h3 className="card-title">Withdraw to USDT</h3>

      {unavailable && (
        <div className="status-banner info">
          Withdrawals are not available yet. Please check back later.
        </div>
      )}

      {error && <div className="status-banner error">{error}</div>}

      {!redemption && (
        <form onSubmit={handleCreate}>
          <p className="redeem-note" style={{ marginTop: 0 }}>
            Burn CLT and receive USDT (TRC-20) at a Tron address you control. Check the address
            character by character: a burn cannot be undone, and USDT sent to the wrong address
            cannot be recovered.
          </p>

          <label className="label" htmlFor="withdrawPayoutAddress">
            Tron address to pay
          </label>
          <input
            id="withdrawPayoutAddress"
            className="input-field"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="T…"
            value={payoutAddress}
            onChange={(e) => setPayoutAddress(e.target.value)}
            disabled={busy || unavailable}
          />

          <label className="label" htmlFor="withdrawAmount" style={{ marginTop: '0.75rem' }}>
            Amount (CLT)
          </label>
          <input
            id="withdrawAmount"
            className="input-field"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="5"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy || unavailable}
          />

          {/* No quick-amount buttons, unlike Top up: sending more USDT is harmless, burning more
              CLT is not. */}
          <button
            type="submit"
            className="btn-primary"
            style={{ marginTop: '0.9rem' }}
            disabled={busy || unavailable}
          >
            {busy ? 'Starting…' : 'Start withdrawal'}
          </button>
        </form>
      )}

      {redemption && (
        <div>
          <div className="redeem-row">
            <span className="redeem-row-label">Burning</span>
            <span>{formatCltAmount(redemption.amountClt)} CLT</span>
          </div>
          {feeOf(redemption) > 0n && (
            <div className="redeem-row">
              <span className="redeem-row-label">Withdrawal fee</span>
              <span>{formatCltAmount(feeOf(redemption).toString())} USDT</span>
            </div>
          )}
          <div className="redeem-row">
            <span className="redeem-row-label">You receive</span>
            <span>{formatCltAmount(netOf(redemption))} USDT</span>
          </div>
          <div className="redeem-row">
            <span className="redeem-row-label">Status</span>
            <span className="redeem-status">
              {REDEMPTION_STATUS_LABELS[status] ?? status}
            </span>
          </div>

          <p className="label" style={{ marginTop: '0.75rem' }}>
            Paying to
          </p>
          <CopyableValue value={redemption.payoutAddress} className="deposit-address" />

          <p className="label" style={{ marginTop: '0.75rem' }}>
            Reference
          </p>
          <CopyableValue value={redemption.redemptionRef} className="deposit-address" />

          {canBurn && (
            <>
              <p className="redeem-note">
                Nothing has been burned yet — your CLT is untouched until you confirm below.
              </p>
              <button type="button" className="btn-primary" onClick={handleBurn} disabled={busy}>
                {busy ? 'Burning…' : `Burn ${formatCltAmount(redemption.amountClt)} CLT and withdraw`}
              </button>
            </>
          )}

          {awaitingBurn && (
            <p className="redeem-note">
              Your burn has been submitted. This updates on its own once the chain confirms it.
            </p>
          )}

          {/* Deliberately does NOT say the payout is owed. `failed` is written in exactly one
              place treasury-side — the burn-mismatch branch of `watcher::confirm_burn`, which ends
              "failing intent, never paying out". Telling someone their money is on its way when
              the treasury has refused it is worse than telling them nothing. */}
          {needsReview && (
            <p className="redeem-note">
              Something about this withdrawal did not match what the treasury expected, and a person
              is reviewing it. Send support the amount and reference above — do not start another
              withdrawal for it.
            </p>
          )}

          {status === 'gone' && (
            <p className="redeem-note">
              The withdrawal service can no longer find this withdrawal. Do not burn anything for
              it. Keep the reference above and send it to support.
            </p>
          )}

          {canStartAnother && (
            <>
              <button
                type="button"
                className="btn-secondary"
                style={{ marginTop: '0.9rem' }}
                onClick={handleStartAnother}
                disabled={busy}
              >
                Start another withdrawal
              </button>
              <p className="redeem-note">
                Copy the reference first — this clears the withdrawal from this device only.
              </p>
            </>
          )}
        </div>
      )}

      <PrivateKeyModal />
      <ConfirmModal />
    </div>
  );
};

export default WithdrawPanel;
