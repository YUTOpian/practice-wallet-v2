import { appState } from "./config.js";
import { autoConnectSSS } from "./sss.js";
import { refreshAccount } from "./account.js";
import { sendTx } from "./transfer.js";
import { loadRecentTx, initLiveTx } from "./transactions.js";
import { initWebSocket } from "./ws.js";
import { initSdk } from "./sdk.js";
import { showPopup } from "./utils.js";
import { checkHarvestStatus, startHarvest } from "./harvest.js";
import QRCode from "https://esm.sh/qrcode";

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
  // SDK初期化
  // ============================
  await initSdk();
  await refreshAccount();

  // ============================
  // ページ取得
  // ============================
  const accountPage = document.getElementById("account-page");
  const sendPage = document.getElementById("send-page");
  const transferPage = document.getElementById("transfer-page");
  const receivePage = document.getElementById("receive-page");
  const harvestPage = document.getElementById("harvest-page");

  // ============================
  // ページ切替
  // ============================
  function showPage(page) {
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    page.classList.add("active");
  }

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
    qr.innerHTML = "";

    const dataUrl = await QRCode.toDataURL(address, {
      width: 220,
      margin: 1
    });
    qr.innerHTML = `<img src="${dataUrl}">`;
  });

  // ============================
  // ハーベスト画面
  // ============================
  document.getElementById("harvest-btn")?.addEventListener("click", async () => {
    showPage(harvestPage);
    const address = appState.currentAddress.toString();
    document.getElementById("harvest-address").textContent = address;

    await checkHarvestStatus(address);
  });

  // ============================
  // ハーベスト開始
  // ============================
  document.getElementById("start-harvest-btn")?.addEventListener("click", startHarvest);

  // ============================
  // 戻る
  // ============================
  document.getElementById("back-account")?.addEventListener("click", () => showPage(accountPage));
  document.getElementById("back-account-receive")?.addEventListener("click", () => showPage(accountPage));
  document.getElementById("back-account-harvest")?.addEventListener("click", () => showPage(accountPage));

  // ============================
  // コピー
  // ============================
  document.getElementById("copy-address-btn")?.addEventListener("click", () => {
    navigator.clipboard.writeText(appState.currentAddress.toString());
    showPopup("アドレスをコピーしました");
  });

  // ============================
  // Tx履歴
  // ============================
  await loadRecentTx();

  if (appState.currentAddress) {
    initWebSocket(appState.currentAddress.toString());
    initLiveTx(appState.currentAddress.toString());
  }
});
