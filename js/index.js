// index.js

import { appState } from "./config.js";
import { autoConnectSSS } from "./sss.js";
import { sendTx } from "./transfer.js";
import { loadRecentTx, initLiveTx } from "./transactions.js";
import { initWebSocket } from "./ws.js";
import { showPopup } from "./utils.js";
import { checkHarvestStatus, startHarvest, stopHarvest, loadHarvestNodeCandidates } from "./harvest.js";
import {
  showCurrentNode,
  loadNodeSettingsCandidates,
  applyNodeChange,
  loadFeeSettings,
  selectFeeOption,
  applyFeeSettings,
} from "./settings.js";
import QRCode from "https://esm.sh/qrcode";
import { QRCodeGenerator } from "https://esm.sh/symbol-qr-library";
import { firstValueFrom } from "https://esm.sh/rxjs";

window.addEventListener("load", async () => {
  // ============================
  // SSS初期化
  // ============================
  await new Promise(resolve => setTimeout(resolve, 1000));
  await autoConnectSSS();

  if (!window.SSS || !window.SSS.activePublicKey) {
    showPopup("⚠️ SSS Extension とリンクしてください", true);
    return;
  }

  // ============================
  // ページ取得
  // ============================
  const accountPage = document.getElementById("account-page");
  const sendPage = document.getElementById("send-page");
  const transferPage = document.getElementById("transfer-page");
  const receivePage = document.getElementById("receive-page");
  const harvestPage = document.getElementById("harvest-page");
  const settingsPage = document.getElementById("settings-page");
  const nodeSettingsPage = document.getElementById("node-settings-page");
  const feeSettingsPage = document.getElementById("fee-settings-page");

  // ============================
  // ページ切替
  // ============================
  function showPage(page) {
    document.querySelectorAll(".page").forEach(p => {
      p.classList.remove("active");
    });
    page.classList.add("active");
  }

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
  });

  // ============================
  // ハーベスト開始
  // ============================
  document.getElementById("start-harvest-btn")?.addEventListener("click", startHarvest);
  document.getElementById("stop-harvest-btn")?.addEventListener("click", stopHarvest);

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

  // ============================
  // Tx履歴・WebSocket
  // ============================
  await loadRecentTx();

  if (appState.currentAddress) {
    initWebSocket(appState.currentAddress.toString());
    initLiveTx(appState.currentAddress.toString());
  }
});
