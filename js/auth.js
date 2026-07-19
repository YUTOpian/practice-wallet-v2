// auth.js
// 認証方式の管理: SSS Extension接続 / ニーモニックインポート(ローカル署名)
// パスワードを設定した場合のみ、暗号化したニーモニックをlocalStorageに保存する

import { appState, NetworkType } from "./config.js";
import { selectNode } from "./nodeSelector.js";
import { initSdk } from "./sdk.js";
import { refreshAccount } from "./account.js";
import { loadRecentTx, initLiveTx } from "./transactions.js";
import { initWebSocket } from "./ws.js";
import { setText } from "./ui.js";

const VAULT_KEY = "walletVault";

// Symbol公式ウォレットと同じ導出パス
const DERIVATION_PATH = "m/44'/4343'/0'/0'/0'";

/* ============================================================
   ニーモニック → 秘密鍵 (BIP39 + SLIP-10)
   @scure/bip39 と micro-ed25519-hdkey はどちらもNode.jsのBufferに
   依存しない監査済みの純粋なJS実装で、ブラウザでの動作実績が多いため採用。
   導出パスはSymbol公式ウォレットと同じ m/44'/4343'/0'/0'/0'
============================================================ */
async function deriveFromMnemonic(mnemonicPhrase) {
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

  const seed = bip39.mnemonicToSeedSync(normalized);
  const hdkey = HDKey.fromMasterSeed(seed);
  const child = hdkey.derive(DERIVATION_PATH);

  const privateKeyHex = Array.from(child.privateKey)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

  return privateKeyHex;
}

/* ============================================================
   ログイン後の共通セットアップ (ノード選択・SDK初期化・残高取得等)
============================================================ */
async function finalizeLogin(networkType) {
  setText("network-label", networkType === NetworkType.TESTNET ? "Testnet" : "Mainnet");

  const isTestnet = networkType === NetworkType.TESTNET;
  appState.NODE = await selectNode(isTestnet);
  await initSdk();

  if (appState.authMode === "local") {
    const keyPair = new appState.facade.static.KeyPair(
      new appState.sdkCore.PrivateKey(appState.localPrivateKeyHex)
    );
    appState.localKeyPair = keyPair;
    appState.currentPubKey = keyPair.publicKey.toString();
    appState.currentAddress = appState.facade.network.publicKeyToAddress(keyPair.publicKey);
  }

  const addressEl = document.getElementById("account-address");
  if (addressEl) addressEl.textContent = appState.currentAddress.toString();

  await refreshAccount();
  await loadRecentTx();

  if (appState.currentAddress) {
    const address = appState.currentAddress.toString();
    initWebSocket(address);
    initLiveTx(address);
  }
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

  appState.authMode = "sss";
  appState.currentPubKey = pubKey;
  appState.networkType = networkType;

  const isTestnet = networkType === NetworkType.TESTNET;
  appState.NODE = await selectNode(isTestnet);
  await initSdk();

  const pub = new appState.sdkCore.PublicKey(pubKey);
  const publicAccount = appState.facade.createPublicAccount(pub);
  appState.currentAddress = publicAccount.address;

  setText("network-label", isTestnet ? "Testnet" : "Mainnet");
  const addressEl = document.getElementById("account-address");
  if (addressEl) addressEl.textContent = publicAccount.address.toString();

  await refreshAccount();
  await loadRecentTx();
  initWebSocket(appState.currentAddress.toString());
  initLiveTx(appState.currentAddress.toString());
}

/* ============================================================
   ニーモニックでログイン
============================================================ */
export async function loginWithMnemonic(mnemonicPhrase, networkType) {
  const privateKeyHex = await deriveFromMnemonic(mnemonicPhrase);

  appState.authMode = "local";
  appState.networkType = networkType;
  appState.localPrivateKeyHex = privateKeyHex;

  await finalizeLogin(networkType);
}

/* ============================================================
   暗号化ボールト (パスワード設定時のみ使用)
   AES-GCM + PBKDF2(210,000回)でニーモニックを暗号化してlocalStorageへ
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

export function hasVault() {
  return !!localStorage.getItem(VAULT_KEY);
}

export function clearVault() {
  localStorage.removeItem(VAULT_KEY);
}

export async function saveVault(mnemonicPhrase, networkType, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKeyFromPassword(password, salt);
  const plain = new TextEncoder().encode(JSON.stringify({ mnemonicPhrase, networkType }));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);

  localStorage.setItem(
    VAULT_KEY,
    JSON.stringify({
      salt: bufToBase64(salt),
      iv: bufToBase64(iv),
      cipher: bufToBase64(cipher),
    })
  );
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

  const { mnemonicPhrase, networkType } = JSON.parse(new TextDecoder().decode(plainBuf));
  await loginWithMnemonic(mnemonicPhrase, networkType);
}

/* ============================================================
   ローカル署名 (ニーモニックログイン時、SSS Extensionを使わない署名)
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
