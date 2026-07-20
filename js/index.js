// index.js

import { appState, NetworkType } from "./config.js";
import { sendTx } from "./transfer.js";
import { loadRecentTx, initLiveTx } from "./transactions.js";
import { initWebSocket } from "./ws.js";
import { showPopup } from "./utils.js";
import { setStatus } from "./ui.js";
import { checkHarvestStatus, startHarvest, stopHarvest, loadHarvestNodeCandidates, loadHarvestHistory } from "./harvest.js";
import {
  showCurrentNode,
  loadNodeSettingsCandidates,
  applyNodeChange,
  loadFeeSettings,
  selectFeeOption,
  applyFeeSettings,
} from "./settings.js";
import {
  connectWithSSS,
  loginWithMnemonic,
  hasVault,
  unlockVault,
  saveVault,
  clearVault,
  logout,
  switchToAccount,
  setAccountHidden,
  addAccountFromMnemonic,
  addAccountFromPrivateKey,
  addNextAccountFromCurrentMnemonic,
  hasCurrentMnemonic,
} from "./auth.js";
import {
  updateSwitcherVisibility,
  renderAccountSwitcherList,
  renderHiddenAccountList,
  nextMnemonicAccountIndex,
} from "./accountSwitcher.js";
import {
  loadOwnedNamespaces,
  populateParentNamespaceSelect,
  registerRootNamespace,
  registerChildNamespace,
} from "./namespace.js";
import {
  loadOwnedMosaicsWithAlias,
  populateMosaicNamespaceSelect,
  createMosaic,
  linkNamespaceToMosaic,
} from "./mosaic.js";
import QRCode from "https://esm.sh/qrcode";
import { QRCodeGenerator } from "https://esm.sh/symbol-qr-library";
import { firstValueFrom } from "https://esm.sh/rxjs";

window.addEventListener("load", async () => {
  // ============================
  // ページ取得
  // ============================
  const welcomePage = document.getElementById("welcome-page");
  const mnemonicImportPage = document.getElementById("mnemonic-import-page");
  const passwordSetupPage = document.getElementById("password-setup-page");
  const unlockPage = document.getElementById("unlock-page");
  const accountPage = document.getElementById("account-page");
  const sendPage = document.getElementById("send-page");
  const transferPage = document.getElementById("transfer-page");
  const receivePage = document.getElementById("receive-page");
  const harvestPage = document.getElementById("harvest-page");
  const settingsPage = document.getElementById("settings-page");
  const nodeSettingsPage = document.getElementById("node-settings-page");
  const feeSettingsPage = document.getElementById("fee-settings-page");
  const accountSwitcherPage = document.getElementById("account-switcher-page");
  const hiddenAccountsPage = document.getElementById("hidden-accounts-page");
  const addAccountMenuPage = document.getElementById("add-account-menu-page");
  const addAccountMnemonicPage = document.getElementById("add-account-mnemonic-page");
  const addAccountPrivatekeyPage = document.getElementById("add-account-privatekey-page");
  const advancedPage = document.getElementById("advanced-page");
  const namespacePage = document.getElementById("namespace-page");
  const mosaicPage = document.getElementById("mosaic-page");

  // ============================
  // ページ切替
  // ============================
  function showPage(page) {
    document.querySelectorAll(".page").forEach(p => {
      p.classList.remove("active");
    });
    page.classList.add("active");
  }

  function goHome() {
    updateSwitcherVisibility();
    showPage(accountPage);
  }

  // ============================
  // 起動時の初期画面判定
  // 保存済みアカウント(パスワード設定済み)があればロック解除画面、
  // なければログイン方法選択画面を表示する
  // ============================
  if (hasVault()) {
    showPage(unlockPage);
  } else {
    showPage(welcomePage);
  }

  // ============================
  // SSS Extensionと接続
  // ============================
  document.getElementById("choose-sss")?.addEventListener("click", async () => {
    setStatus("welcome-status", "SSS Extensionに接続中...");
    try {
      await connectWithSSS();
      goHome();
    } catch (e) {
      console.error("connectWithSSS error:", e);
      setStatus("welcome-status", e.message || "SSS Extensionとの接続に失敗しました。", "error");
    }
  });

  // ============================
  // ニーモニックインポート画面へ
  // ============================
  document.getElementById("choose-mnemonic")?.addEventListener("click", () => {
    showPage(mnemonicImportPage);
  });

  document.getElementById("back-welcome-mnemonic")?.addEventListener("click", () => showPage(welcomePage));

  document.getElementById("import-mnemonic-btn")?.addEventListener("click", async () => {
    const mnemonicPhrase = document.getElementById("mnemonic-input").value.trim();
    const networkChoice = document.getElementById("mnemonic-network-select").value;
    const networkType = networkChoice === "testnet" ? NetworkType.TESTNET : NetworkType.MAINNET;

    if (!mnemonicPhrase) {
      setStatus("mnemonic-import-status", "ニーモニックを入力してください。", "error");
      return;
    }

    setStatus("mnemonic-import-status", "インポート中...");
    try {
      await loginWithMnemonic(mnemonicPhrase, networkType);
      document.getElementById("mnemonic-input").value = "";
      setStatus("mnemonic-import-status", "", "default");
      showPage(passwordSetupPage);
    } catch (e) {
      console.error("loginWithMnemonic error:", e);
      setStatus("mnemonic-import-status", e.message || "インポートに失敗しました。", "error");
    }
  });

  // ============================
  // パスワード設定(任意)
  // この時点でアカウントは既にappState.accountsに追加済みなので、
  // saveVaultはパスワードだけ受け取って現在のアカウント一覧を暗号化保存する
  // ============================
  document.getElementById("save-password-btn")?.addEventListener("click", async () => {
    const pw = document.getElementById("setup-password-input").value;
    const pwConfirm = document.getElementById("setup-password-confirm").value;

    if (!pw || pw.length < 8) {
      setStatus("password-setup-status", "8文字以上のパスワードを入力してください。", "error");
      return;
    }
    if (pw !== pwConfirm) {
      setStatus("password-setup-status", "パスワードが一致しません。", "error");
      return;
    }

    try {
      await saveVault(pw);
      document.getElementById("setup-password-input").value = "";
      document.getElementById("setup-password-confirm").value = "";
      goHome();
    } catch (e) {
      console.error("saveVault error:", e);
      setStatus("password-setup-status", "保存に失敗しました。", "error");
    }
  });

  document.getElementById("skip-password-btn")?.addEventListener("click", () => {
    goHome();
  });

  // ============================
  // ロック解除(保存済みアカウントでログイン)
  // ============================
  document.getElementById("unlock-btn")?.addEventListener("click", async () => {
    const pw = document.getElementById("unlock-password-input").value;
    if (!pw) {
      setStatus("unlock-status", "パスワードを入力してください。", "error");
      return;
    }
    setStatus("unlock-status", "ログイン中...");
    try {
      await unlockVault(pw);
      document.getElementById("unlock-password-input").value = "";
      goHome();
    } catch (e) {
      console.error("unlockVault error:", e);
      setStatus("unlock-status", e.message || "ログインに失敗しました。", "error");
    }
  });

  document.getElementById("forget-account-btn")?.addEventListener("click", () => {
    if (!confirm("保存済みのアカウント情報をこの端末から削除します。よろしいですか？")) return;
    clearVault();
    showPage(welcomePage);
  });

  // 送金画面に「保有トークン一覧」から直接入ったかどうか
  let cameFromMosaicList = false;
  const backSendBtn = document.getElementById("back-send");

  // ============================
  // 送金画面
  // ============================
  document.getElementById("send-btn")?.addEventListener("click", () => {
    showPage(sendPage);
    const sendList = document.getElementById("send-mosaic-list");
    const mosaicList = document.getElementById("mosaic-list");

    if (sendList && mosaicList) {
      sendList.innerHTML = mosaicList.innerHTML;
    }
  });

  // ============================
  // モザイク選択
  // ============================
  document.getElementById("send-mosaic-list")?.addEventListener("click", e => {
    const item = e.target.closest(".mosaic-item");
    if (!item) return;

    document.getElementById("selected-mosaic-name").textContent = 
      item.querySelector(".mosaic-name")?.textContent;

    document.getElementById("selected-mosaic-id").value = 
      item.querySelector(".mosaic-id")?.textContent;

    cameFromMosaicList = false;
    if (backSendBtn) backSendBtn.textContent = "← トークン選択へ戻る";
    showPage(transferPage);
  });

  // ============================
  // 保有トークン一覧から直接送金画面へ
  // ============================
  document.getElementById("mosaic-list")?.addEventListener("click", e => {
    const item = e.target.closest(".mosaic-item");
    if (!item) return;

    // 選択情報(selected-mosaic-id / name / balance)は
    // account.js 側の item.onclick で既にセット済み
    cameFromMosaicList = true;
    if (backSendBtn) backSendBtn.textContent = "← 戻る";
    showPage(transferPage);
  });

  // ============================
  // 送金実行
  // ============================
  document.getElementById("btn-transfer")?.addEventListener("click", sendTx);

  // ============================
  // 受取画面
  // ============================
  document.getElementById("receive-btn")?.addEventListener("click", async () => {
    showPage(receivePage);
    const address = appState.currentAddress.toString();

    document.getElementById("receive-address").textContent = address;
    const qr = document.getElementById("receive-qrcode");
    qr.innerHTML = "読み込み中...";

    try {
      if (!appState.generationHash || !appState.networkType) {
        throw new Error("ネットワーク情報が未取得です");
      }

      // 他のSymbolウォレット(公式モバイルウォレット等)が読み込める
      // 形式(symbol-qr-library の AddressQR)でQRコードを生成する
      const addressQR = QRCodeGenerator.createExportAddress(
        "Symbol Simple Wallet",
        address,
        appState.networkType,
        appState.generationHash
      );

      const dataUrl = await firstValueFrom(addressQR.toBase64());
      qr.innerHTML = `<img src="${dataUrl}" alt="QR Code">`;
    } catch (e) {
      console.error("AddressQR生成失敗、通常QRにフォールバック", e);
      const dataUrl = await QRCode.toDataURL(address, {
        width: 220,
        margin: 1
      });
      qr.innerHTML = `<img src="${dataUrl}" alt="QR Code">`;
    }
  });

  // ============================
  // 受け取りアドレスコピー
  // ============================
  document.getElementById("copy-receive-address")?.addEventListener("click", () => {
    navigator.clipboard.writeText(appState.currentAddress.toString());
    showPopup("アドレスをコピーしました");
  });

  // ============================
  // ハーベスト画面
  // ============================
  document.getElementById("harvest-btn")?.addEventListener("click", async () => {
    showPage(harvestPage);
    const address = appState.currentAddress.toString();
    document.getElementById("harvest-address").textContent = address;

    await checkHarvestStatus();
    await loadHarvestNodeCandidates();
    await loadHarvestHistory();
  });

  // ============================
  // ハーベスト開始
  // ============================
  document.getElementById("start-harvest-btn")?.addEventListener("click", startHarvest);
  document.getElementById("stop-harvest-btn")?.addEventListener("click", stopHarvest);

  // ============================
  // 高度機能
  // ============================
  document.getElementById("advanced-btn")?.addEventListener("click", () => {
    showPage(advancedPage);
  });

  document.getElementById("menu-namespace")?.addEventListener("click", async () => {
    showPage(namespacePage);
    await loadOwnedNamespaces();
    await populateParentNamespaceSelect();
  });

  document.getElementById("menu-mosaic")?.addEventListener("click", async () => {
    showPage(mosaicPage);
    await loadOwnedMosaicsWithAlias();
    await populateMosaicNamespaceSelect();
  });

  document.getElementById("register-root-namespace-btn")?.addEventListener("click", async () => {
    const name = document.getElementById("root-namespace-name").value.trim();
    const duration = parseInt(document.getElementById("root-namespace-duration").value, 10);

    if (!name) {
      setStatus("root-namespace-status", "ネームスペース名を入力してください。", "error");
      return;
    }
    if (!Number.isInteger(duration) || duration <= 0) {
      setStatus("root-namespace-status", "有効期間(ブロック数)を正しく入力してください。", "error");
      return;
    }

    setStatus("root-namespace-status", "登録中...");
    try {
      const hash = await registerRootNamespace(name, duration);
      setStatus("root-namespace-status", `✅ 登録リクエストを送信しました。Hash: ${hash}`, "success");
      document.getElementById("root-namespace-name").value = "";
      document.getElementById("root-namespace-duration").value = "";
      await loadOwnedNamespaces();
      await populateParentNamespaceSelect();
    } catch (e) {
      console.error("registerRootNamespace error:", e);
      setStatus("root-namespace-status", e.message || "登録に失敗しました。", "error");
    }
  });

  document.getElementById("register-child-namespace-btn")?.addEventListener("click", async () => {
    const parentId = document.getElementById("child-namespace-parent-select").value;
    const childName = document.getElementById("child-namespace-name").value.trim();

    if (!parentId) {
      setStatus("child-namespace-status", "親ネームスペースを選択してください。", "error");
      return;
    }
    if (!childName) {
      setStatus("child-namespace-status", "子ネームスペース名を入力してください。", "error");
      return;
    }

    setStatus("child-namespace-status", "登録中...");
    try {
      const hash = await registerChildNamespace(parentId, childName);
      setStatus("child-namespace-status", `✅ 登録リクエストを送信しました。Hash: ${hash}`, "success");
      document.getElementById("child-namespace-name").value = "";
      await loadOwnedNamespaces();
      await populateParentNamespaceSelect();
    } catch (e) {
      console.error("registerChildNamespace error:", e);
      setStatus("child-namespace-status", e.message || "登録に失敗しました。", "error");
    }
  });

  document.getElementById("owned-mosaic-list")?.addEventListener("click", async e => {
    const btn = e.target.closest('[data-action="link-mosaic"]');
    if (!btn) return;

    const mosaicId = btn.dataset.mosaicId;
    const select = document.querySelector(`.mosaic-link-select[data-mosaic-id="${mosaicId}"]`);
    const namespaceId = select?.value;

    if (!namespaceId) {
      alert("ネームスペースを選択してください。");
      return;
    }

    btn.disabled = true;
    btn.textContent = "リンク中...";
    try {
      await linkNamespaceToMosaic(mosaicId, namespaceId);
      alert("✅ リンクリクエストを送信しました。");
      await loadOwnedMosaicsWithAlias();
    } catch (e) {
      console.error("linkNamespaceToMosaic error:", e);
      alert(e.message || "リンクに失敗しました。");
      btn.disabled = false;
      btn.textContent = "リンクする";
    }
  });

  document.getElementById("create-mosaic-btn")?.addEventListener("click", async () => {
    const divisibility = parseInt(document.getElementById("mosaic-divisibility").value, 10) || 0;
    const durationBlocks = parseInt(document.getElementById("mosaic-duration").value, 10) || 0;
    const initialSupply = parseFloat(document.getElementById("mosaic-initial-supply").value) || 0;
    const transferable = document.getElementById("mosaic-transferable").checked;
    const supplyMutable = document.getElementById("mosaic-supply-mutable").checked;
    const restrictable = document.getElementById("mosaic-restrictable").checked;
    const linkNamespaceIdHex = document.getElementById("mosaic-link-namespace-select").value || null;

    setStatus("mosaic-create-status", "作成中...");
    try {
      const hash = await createMosaic({
        divisibility,
        durationBlocks,
        supplyMutable,
        transferable,
        restrictable,
        initialSupply,
        linkNamespaceIdHex,
      });
      setStatus("mosaic-create-status", `✅ 作成リクエストを送信しました。Hash: ${hash}`, "success");
      await loadOwnedMosaicsWithAlias();
    } catch (e) {
      console.error("createMosaic error:", e);
      setStatus("mosaic-create-status", e.message || "作成に失敗しました。", "error");
    }
  });

  // ============================
  // 設定メニュー
  // ============================
  document.getElementById("settings-btn")?.addEventListener("click", () => {
    showPage(settingsPage);
  });

  document.getElementById("menu-node-settings")?.addEventListener("click", async () => {
    showPage(nodeSettingsPage);
    showCurrentNode();
    await loadNodeSettingsCandidates();
  });

  document.getElementById("menu-fee-settings")?.addEventListener("click", async () => {
    showPage(feeSettingsPage);
    await loadFeeSettings();
  });

  document.getElementById("apply-node-btn")?.addEventListener("click", applyNodeChange);

  document.getElementById("fee-options")?.addEventListener("click", e => {
    const option = e.target.closest(".fee-option");
    if (!option) return;
    selectFeeOption(option);
  });

  document.getElementById("apply-fee-btn")?.addEventListener("click", applyFeeSettings);

  document.getElementById("logout-btn")?.addEventListener("click", () => {
    if (!confirm("ログアウトします。次回は再度ニーモニックの入力（またはSSS Extension接続）が必要になります。よろしいですか？")) return;
    logout();
    showPage(welcomePage);
  });

  // ============================
  // アカウント切替(▼マーク)
  // ============================
  document.getElementById("account-switch-btn")?.addEventListener("click", () => {
    renderAccountSwitcherList();
    showPage(accountSwitcherPage);
  });

  document.getElementById("account-switcher-list")?.addEventListener("click", async e => {
    const hideBtn = e.target.closest('[data-action="hide"]');
    if (hideBtn) {
      const id = hideBtn.dataset.id;
      await setAccountHidden(id, true);
      renderAccountSwitcherList();
      return;
    }

    const row = e.target.closest('[data-action="switch"]');
    if (row) {
      const id = row.dataset.id;
      if (id === appState.activeAccountId) return;
      try {
        await switchToAccount(id);
        updateSwitcherVisibility();
        goHome();
      } catch (err) {
        console.error("switchToAccount error:", err);
        alert(err.message || "アカウントの切替に失敗しました。");
      }
    }
  });

  document.getElementById("add-account-btn")?.addEventListener("click", async () => {
    if (hasCurrentMnemonic()) {
      try {
        await addNextAccountFromCurrentMnemonic();
        updateSwitcherVisibility();
        renderAccountSwitcherList();
        showPage(accountSwitcherPage);
      } catch (e) {
        console.error("addNextAccountFromCurrentMnemonic error:", e);
        alert(e.message || "アカウントの追加に失敗しました。");
      }
      return;
    }

    // ニーモニックがメモリ上にない場合(SSSのみ利用中など)は
    // 秘密鍵の直接入力で追加する
    showPage(addAccountPrivatekeyPage);
  });

  document.getElementById("manage-hidden-accounts-btn")?.addEventListener("click", () => {
    renderHiddenAccountList();
    showPage(hiddenAccountsPage);
  });

  document.getElementById("hidden-account-list")?.addEventListener("click", async e => {
    const btn = e.target.closest('[data-action="unhide"]');
    if (!btn) return;
    await setAccountHidden(btn.dataset.id, false);
    renderHiddenAccountList();
  });

  // ============================
  // アカウント追加(設定・アカウント切替の両方から使う共通画面)
  // ============================
  document.getElementById("menu-add-mnemonic")?.addEventListener("click", () => {
    document.getElementById("add-mnemonic-index").value = nextMnemonicAccountIndex();
    showPage(addAccountMnemonicPage);
  });

  document.getElementById("menu-add-privatekey")?.addEventListener("click", () => {
    showPage(addAccountPrivatekeyPage);
  });

  document.getElementById("add-account-mnemonic-choice")?.addEventListener("click", () => {
    document.getElementById("add-mnemonic-index").value = nextMnemonicAccountIndex();
    showPage(addAccountMnemonicPage);
  });

  document.getElementById("add-account-privatekey-choice")?.addEventListener("click", () => {
    showPage(addAccountPrivatekeyPage);
  });

  document.getElementById("add-mnemonic-submit")?.addEventListener("click", async () => {
    const mnemonicPhrase = document.getElementById("add-mnemonic-input").value.trim();
    const accountIndex = parseInt(document.getElementById("add-mnemonic-index").value, 10) || 0;
    const label = document.getElementById("add-mnemonic-label").value;

    if (!mnemonicPhrase) {
      setStatus("add-mnemonic-status", "ニーモニックを入力してください。", "error");
      return;
    }

    setStatus("add-mnemonic-status", "追加中...");
    try {
      await addAccountFromMnemonic(mnemonicPhrase, accountIndex, label);
      document.getElementById("add-mnemonic-input").value = "";
      document.getElementById("add-mnemonic-label").value = "";
      updateSwitcherVisibility();
      goHome();
    } catch (e) {
      console.error("addAccountFromMnemonic error:", e);
      setStatus("add-mnemonic-status", e.message || "追加に失敗しました。", "error");
    }
  });

  document.getElementById("add-privatekey-submit")?.addEventListener("click", async () => {
    const privateKeyHex = document.getElementById("add-privatekey-input").value.trim();
    const label = document.getElementById("add-privatekey-label").value;

    if (!privateKeyHex) {
      setStatus("add-privatekey-status", "秘密鍵を入力してください。", "error");
      return;
    }

    setStatus("add-privatekey-status", "追加中...");
    try {
      await addAccountFromPrivateKey(privateKeyHex, label);
      document.getElementById("add-privatekey-input").value = "";
      document.getElementById("add-privatekey-label").value = "";
      updateSwitcherVisibility();
      goHome();
    } catch (e) {
      console.error("addAccountFromPrivateKey error:", e);
      setStatus("add-privatekey-status", e.message || "追加に失敗しました。", "error");
    }
  });

  // ============================
  // 戻る
  // ============================
  document.getElementById("back-account")?.addEventListener("click", () => showPage(accountPage));
  backSendBtn?.addEventListener("click", () => {
    showPage(cameFromMosaicList ? accountPage : sendPage);
  });
  document.getElementById("back-account-receive")?.addEventListener("click", () => showPage(accountPage));
  document.getElementById("back-account-harvest")?.addEventListener("click", () => showPage(accountPage));
  document.getElementById("back-account-settings")?.addEventListener("click", () => showPage(accountPage));
  document.getElementById("back-settings-node")?.addEventListener("click", () => showPage(settingsPage));
  document.getElementById("back-settings-fee")?.addEventListener("click", () => showPage(settingsPage));
  document.getElementById("back-account-switcher")?.addEventListener("click", () => showPage(accountPage));
  document.getElementById("back-hidden-accounts")?.addEventListener("click", () => showPage(accountSwitcherPage));
  document.getElementById("back-add-account-menu")?.addEventListener("click", () => showPage(accountSwitcherPage));
  document.getElementById("back-add-account-mnemonic")?.addEventListener("click", () => showPage(accountPage));
  document.getElementById("back-add-account-privatekey")?.addEventListener("click", () => showPage(accountPage));
  document.getElementById("back-account-advanced")?.addEventListener("click", () => showPage(accountPage));
  document.getElementById("back-advanced-namespace")?.addEventListener("click", () => showPage(advancedPage));
  document.getElementById("back-advanced-mosaic")?.addEventListener("click", () => showPage(advancedPage));

  // ============================
  // タブ切替
  // ============================
  const tabToken = document.getElementById("tab-token");
  const tabActivity = document.getElementById("tab-activity");
  const tokenContent = document.getElementById("token-content");
  const activityContent = document.getElementById("activity-content");

  tabToken?.addEventListener("click", () => {
    tabToken.classList.add("active");
    tabActivity.classList.remove("active");
    tokenContent.style.display = "block";
    activityContent.style.display = "none";
  });

  tabActivity?.addEventListener("click", () => {
    tabActivity.classList.add("active");
    tabToken.classList.remove("active");
    tokenContent.style.display = "none";
    activityContent.style.display = "block";
  });
  
  // ============================
  // アドレスコピー
  // ============================
  document.getElementById("copy-address-btn")?.addEventListener("click", () => {
    navigator.clipboard.writeText(appState.currentAddress.toString());
    showPopup("アドレスをコピーしました");
  });
});
