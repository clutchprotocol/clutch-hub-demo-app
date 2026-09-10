/**
 * What this app does with a private key, said before anyone creates one.
 *
 * Readiness item F1. Keys are generated in the browser and stored in plaintext `localStorage`
 * (`UserProfile.jsx`, `clutch_{role}_privateKey`). That is a deliberate choice for a demo on a
 * valueless testnet and it is fine there — what was not fine is that nothing said so. A visitor
 * had no way to tell this apart from a wallet, and the pattern is the one every builder copies
 * out of the reference app.
 *
 * Placed at wallet setup rather than in an About tab because this is the moment a key comes into
 * existence, and it is the only moment the warning can change what someone does.
 *
 * Not dismissible. A remembered dismissal would hide it from exactly the person who arrives on a
 * shared machine later.
 */
const KeyStorageNotice = () => (
  <div
    className="status-banner warning"
    role="note"
    style={{ marginBottom: '1rem', textAlign: 'left', lineHeight: 1.55 }}
  >
    <strong>This is a demo, not a wallet.</strong> The key is generated here in your browser and
    kept in this browser&apos;s <code>localStorage</code> in plain text — readable by any script on
    the page, any browser extension, and anyone else using this computer. Clearing site data
    deletes it, and nothing can recover it.
    <br />
    <br />
    Fine for a testnet whose CLT has no value. <strong>Never put real funds behind a key created
    here</strong>, and if you are building on Clutch, do not copy this storage pattern — the SDK
    signs locally, so a hardware wallet, an OS keychain or an external signer can be substituted
    without changing how transactions are built.
  </div>
);

export default KeyStorageNotice;
