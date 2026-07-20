// auth.js
// 認証方式の管理: SSS Extension接続 / ニーモニックインポート・秘密鍵インポート(ローカル署名)
// マルチアカウント対応。パスワードを設定した場合のみ、暗号化してlocalStorageに保存する

import { appState, NetworkType } from "./config.js";
import { selectNode } from "./nodeSelector.js";
import { initSdk } from "./sdk.js";
import { refreshAccount } from "./account.js";
import { loadRecentTx, initLiveTx } from "./transactions.js";
import { initWebSocket, closeWebSocket } from "./ws.js";
import { setText } from "./ui.js";

const VAULT_KEY = "walletVault";

// 現在ログインに使ったニーモニック(セッション中のみメモリ保持、保存はしない)
// これがあれば「アカウント追加」時に毎回ニーモニックを打ち直さずに済む
let currentMnemonicPhrase = null;

export function hasCurrentMnemonic() {
  return !!currentMnemonicPhrase;
}

/* ============================================================
   ニーモニック → 秘密鍵 (BIP39 + SLIP-10)
   @scure/bip39 と micro-ed25519-hdkey はどちらもNode.jsのBufferに
   依存しない監査済みの純粋なJS実装で、ブラウザでの動作実績が多いため採用。
   導出パスはSymbol公式ウォレットと同じ m/44'/4343'/{account}'/0'/0'
   ({account}を変えることで同じニーモニックから複数アカウントを導出できる)
============================================================ */
async function deriveFromMnemonic(mnemonicPhrase, accountIndex = 0) {
  const [bip39, wordlistModule, hdkeyModule] = await Promise.all([
    import("https://esm.sh/@scure/bip39@2.2.0"),
    import("https://esm.sh/@scure/bip39@2.2.0/wordlists/english"),
    import("https://esm.sh/micro-ed25519-hdkey@0.1.2"),
  ]);
  const { wordlist } = wordlistModule;
  const { HDKey } = hdkeyModule;

  // 貼り付け時の改行・連続スペース・全角スペースを単一の半角スペースに正規化
  const normalized = mnemonicPhrase
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, " ");

  const wordCount = normalized.split(" ").filter(Boolean).length;
  console.log("mnemonic word count:", wordCount);

  if (!bip39.validateMnemonic(normalized, wordlist)) {
    throw new Error("ニーモニックの形式が正しくありません（単語数やスペルを確認してください）");
  }

  const idx = Number.isInteger(accountIndex) && accountIndex >= 0 ? accountIndex : 0;
  const path = `m/44'/4343'/${idx}'/0'/0'`;

  const seed = bip39.mnemonicToSeedSync(normalized);
  const hdkey = HDKey.fromMasterSeed(seed);
  const child = hdkey.derive(path);

  const privateKeyHex = Array.from(child.privateKey)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

  return privateKeyHex;
}

/* ============================================================
   アカウント一覧への追加/更新
============================================================ */
function upsertAccount(entry) {
  const idx = appState.accounts.findIndex((a) => a.id === entry.id);
  if (idx >= 0) {
    appState.accounts[idx] = { ...appState.accounts[idx], ...entry };
  } else {
    appState.accounts.push(entry);
  }
}

export function getAccounts() {
  return appState.accounts;
}

/* ============================================================
   アカウント切替（SSS / ニーモニック由来 / 秘密鍵由来 共通）
============================================================ */
export async function switchToAccount(id) {
  const acc = appState.accounts.find((a) => a.id === id);
  if (!acc) {
    throw new Error("アカウントが見つかりません");
  }

  closeWebSocket();

  // ノード/SDKがまだ準備できていなければここで準備する
  // (アカウント追加・切替時は既に準備済みのことが多いので再選択しない)
  if (!appState.isSdkReady) {
    const isTestnet = appState.networkType === NetworkType.TESTNET;
    appState.NODE = await selectNode(isTestnet);
    await initSdk();
  }

  if (acc.source === "sss") {
    if (!window.SSS || !window.SSS.activePublicKey) {
      throw new Error("SSS Extensionが接続されていません");
    }
    appState.authMode = "sss";
    appState.currentPubKey = window.SSS.activePublicKey;
    appState.localPrivateKeyHex = null;
    appState.localKeyPair = null;

    const pub = new appState.sdkCore.PublicKey(appState.currentPubKey);
    appState.currentAddress = appState.facade.createPublicAccount(pub).address;
  } else {
    appState.authMode = "local";
    appState.localPrivateKeyHex = acc.privateKeyHex;

    const keyPair = new appState.facade.static.KeyPair(
      new appState.sdkCore.PrivateKey(acc.privateKeyHex)
    );
    appState.localKeyPair = keyPair;
    appState.currentPubKey = keyPair.publicKey.toString();
    appState.currentAddress = appState.facade.network.publicKeyToAddress(keyPair.publicKey);
  }

  appState.activeAccountId = id;
  acc.address = appState.currentAddress.toString();

  setText("network-label", appState.networkType === NetworkType.TESTNET ? "Testnet" : "Mainnet");
  const addressEl = document.getElementById("account-address");
  if (addressEl) addressEl.textContent = appState.currentAddress.toString();

  await refreshAccount();
  await loadRecentTx();

  const address = appState.currentAddress.toString();
  initWebSocket(address);
  initLiveTx(address);

  await persistAccountsIfVault();
}

/* ============================================================
   SSS Extension 接続
============================================================ */
export async function connectWithSSS() {
  if (!window.SSS || !window.SSS.activePublicKey) {
    throw new Error("SSS Extension とリンクしてください");
  }

  const pubKey = window.SSS.activePublicKey;
  const networkType = Number(window.SSS.activeNetworkType);

  if (!pubKey || ![NetworkType.MAINNET, NetworkType.TESTNET].includes(networkType)) {
    throw new Error("SSSでアカウントを選択してください");
  }

  appState.networkType = networkType;

  const id = "sss:" + pubKey.toUpperCase();
  upsertAccount({ id, label: "SSS Extension", source: "sss", hidden: false });

  await switchToAccount(id);
}

/* ============================================================
   ニーモニックでログイン（初回ログイン用。デフォルトでアカウント0を使う）
============================================================ */
export async function loginWithMnemonic(mnemonicPhrase, networkType, accountIndex = 0) {
  const privateKeyHex = await deriveFromMnemonic(mnemonicPhrase, accountIndex);
  currentMnemonicPhrase = mnemonicPhrase;

  appState.networkType = networkType;

  const id = crypto.randomUUID();
  upsertAccount({
    id,
    label: `アカウント ${accountIndex + 1}`,
    source: "mnemonic",
    privateKeyHex,
    accountIndex,
    hidden: false,
  });

  await switchToAccount(id);
}

/* ============================================================
   アカウント追加（ログイン済みの状態で使う。SSS利用中でも呼べる）
============================================================ */
function isDuplicatePrivateKey(privateKeyHex) {
  return appState.accounts.some(
    (a) => a.privateKeyHex && a.privateKeyHex.toUpperCase() === privateKeyHex.toUpperCase()
  );
}

export async function addAccountFromMnemonic(mnemonicPhrase, accountIndex, label) {
  const privateKeyHex = await deriveFromMnemonic(mnemonicPhrase, accountIndex);

  if (isDuplicatePrivateKey(privateKeyHex)) {
    throw new Error("このアカウントはすでにインポートされています");
  }

  currentMnemonicPhrase = mnemonicPhrase;

  const id = crypto.randomUUID();
  const entry = {
    id,
    label: label?.trim() || `アカウント ${accountIndex + 1}`,
    source: "mnemonic",
    privateKeyHex,
    accountIndex,
    hidden: false,
  };
  upsertAccount(entry);
  await switchToAccount(id);
  return entry;
}

/* ============================================================
   ニーモニックログイン中、既にメモリにあるニーモニックを使って
   次のアカウントをワンクリックで追加する（再入力不要）
============================================================ */
export async function addNextAccountFromCurrentMnemonic(label) {
  if (!currentMnemonicPhrase) {
    throw new Error("ニーモニックがメモリ上にありません（ログインし直すか、秘密鍵で追加してください）");
  }

  const used = appState.accounts
    .filter((a) => a.source === "mnemonic")
    .map((a) => a.accountIndex ?? 0);
  const nextIndex = used.length === 0 ? 0 : Math.max(...used) + 1;

  return await addAccountFromMnemonic(currentMnemonicPhrase, nextIndex, label);
}

export async function addAccountFromPrivateKey(privateKeyHex, label) {
  const normalized = privateKeyHex.trim().toUpperCase().replace(/^0X/, "");
  if (!/^[0-9A-F]{64}$/.test(normalized)) {
    throw new Error("秘密鍵の形式が正しくありません（64桁の16進数を入力してください）");
  }

  if (isDuplicatePrivateKey(normalized)) {
    throw new Error("このアカウントはすでにインポートされています");
  }

  const id = crypto.randomUUID();
  const entry = {
    id,
    label: label?.trim() || "インポートした鍵",
    source: "privateKey",
    privateKeyHex: normalized,
    hidden: false,
  };
  upsertAccount(entry);
  await switchToAccount(id);
  return entry;
}

/* ============================================================
   アカウントの表示/非表示
   非表示は削除ではなく一覧から隠すだけ(秘密鍵は保持されたまま)
============================================================ */
export async function setAccountHidden(id, hidden) {
  const acc = appState.accounts.find((a) => a.id === id);
  if (!acc) return;
  acc.hidden = hidden;
  await persistAccountsIfVault();
}

/* ============================================================
   暗号化ボールト (パスワード設定時のみ使用)
   AES-GCM + PBKDF2(210,000回)でアカウント一覧を暗号化してlocalStorageへ
   (SSS由来のアカウントは秘密鍵を持たないため保存対象外)
============================================================ */
async function deriveKeyFromPassword(password, saltBytes) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: 210000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function bufToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// パスワードから導出した鍵はセッション中だけメモリに保持し、
// アカウント追加や非表示操作のたびにパスワード再入力を求めずに
// 再暗号化・再保存できるようにする(平文パスワードは保持しない)
let sessionSalt = null;
let sessionKey = null;

export function hasVault() {
  return !!localStorage.getItem(VAULT_KEY);
}

export function clearVault() {
  localStorage.removeItem(VAULT_KEY);
  sessionSalt = null;
  sessionKey = null;
}

async function persistAccountsIfVault() {
  if (!sessionKey || !sessionSalt) return; // パスワード未設定ならメモリ内のみ

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const persistable = appState.accounts.filter((a) => a.source !== "sss");
  const plain = new TextEncoder().encode(
    JSON.stringify({
      accounts: persistable,
      networkType: appState.networkType,
      activeAccountId: appState.activeAccountId,
    })
  );
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sessionKey, plain);

  localStorage.setItem(
    VAULT_KEY,
    JSON.stringify({
      salt: bufToBase64(sessionSalt),
      iv: bufToBase64(iv),
      cipher: bufToBase64(cipher),
    })
  );
}

export async function saveVault(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKeyFromPassword(password, salt);
  sessionSalt = salt;
  sessionKey = key;
  await persistAccountsIfVault();
}

export async function unlockVault(password) {
  const raw = localStorage.getItem(VAULT_KEY);
  if (!raw) {
    throw new Error("保存されたアカウントがありません");
  }

  const vault = JSON.parse(raw);
  const salt = base64ToBytes(vault.salt);
  const iv = base64ToBytes(vault.iv);
  const key = await deriveKeyFromPassword(password, salt);

  let plainBuf;
  try {
    plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, base64ToBytes(vault.cipher));
  } catch {
    throw new Error("パスワードが正しくありません");
  }

  const { accounts, networkType, activeAccountId } = JSON.parse(new TextDecoder().decode(plainBuf));

  sessionSalt = salt;
  sessionKey = key;

  appState.accounts = accounts || [];
  appState.networkType = networkType;

  const targetId =
    activeAccountId && appState.accounts.some((a) => a.id === activeAccountId)
      ? activeAccountId
      : appState.accounts[0]?.id;

  if (!targetId) {
    throw new Error("保存されたアカウントがありません");
  }

  await switchToAccount(targetId);
}

/* ============================================================
   ローカル署名 (ニーモニック/秘密鍵ログイン時、SSS Extensionを使わない署名)
============================================================ */
export function signPayloadLocally(tx) {
  const signature = appState.facade.signTransaction(appState.localKeyPair, tx);
  // attachSignatureはアナウンス用のJSON文字列(payload)をそのまま返す
  return appState.facade.transactionFactory.static.attachSignature(tx, signature);
}

export function encryptMessageLocally(recipientPubKeyHex, plainText) {
  const encoder = new appState.sdkSymbol.MessageEncoder(appState.localKeyPair);
  const recipientPub = new appState.sdkCore.PublicKey(recipientPubKeyHex);
  return encoder.encode(recipientPub, new TextEncoder().encode(plainText));
}

/* ============================================================
   署名 → アナウンス（共通処理）
   SSS Extension / ローカル署名の両方に対応。
   ネームスペース登録・モザイク作成など、送金・ハーベスト以外の
   機能からも共通で使う。
============================================================ */
export async function signAndAnnounceTx(tx) {
  let announceBody;
  let signedBytes;

  if (appState.authMode === "local") {
    announceBody = signPayloadLocally(tx);
    signedBytes = appState.sdkCore.utils.hexToUint8(JSON.parse(announceBody).payload);
  } else {
    const payload = appState.sdkCore.utils.uint8ToHex(tx.serialize());

    window.SSS.setTransactionByPayload(payload);
    const signed = await window.SSS.requestSign();
    if (!signed?.payload) {
      throw new Error("SSS署名に失敗しました");
    }

    announceBody = JSON.stringify({ payload: signed.payload });
    signedBytes = appState.sdkCore.utils.hexToUint8(signed.payload);
  }

  const res = await fetch(new URL("/transactions", appState.NODE), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: announceBody,
  });

  const result = await res.json();
  console.log("announce result:", result);

  if (!res.ok) {
    throw new Error(result.message ?? "アナウンス失敗");
  }

  const signedTx = appState.facade.transactionFactory.static.deserialize(signedBytes);
  return appState.facade.hashTransaction(signedTx).toString();
}

/* ============================================================
   ログアウト
   保存済みアカウント(パスワード付きボールト)も削除するため、
   次回は自動ログインできず、必ずSSS接続かニーモニック/秘密鍵の
   再入力が必要になる
============================================================ */
export function logout() {
  clearVault();
  closeWebSocket();
  currentMnemonicPhrase = null;

  appState.authMode = null;
  appState.currentPubKey = null;
  appState.currentAddress = null;
  appState.localPrivateKeyHex = null;
  appState.localKeyPair = null;
  appState.NODE = null;
  appState.isSdkReady = false;
  appState.networkType = null;
  appState.accounts = [];
  appState.activeAccountId = null;
}
