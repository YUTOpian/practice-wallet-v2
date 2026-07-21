// multisend.js
// 複数送信: 手動設定 / CSVインポートのどちらも、複数の送金先を
// 1つの Aggregate Complete Transaction にまとめて送信する

import { appState, getXymMosaicIdHex } from "./config.js";
import { signAndAnnounceTx } from "./auth.js";

// mosaic文字列(ネームスペース名 or 16進ID) → divisibility のキャッシュ
const divisibilityCache = {};

/* ============================================================
   CSVパース (address,mosaic,amount,message ヘッダー行あり想定)
   簡易的なダブルクォート対応つきCSVパーサ
============================================================ */
function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idxAddress = header.indexOf("address");
  const idxMosaic = header.indexOf("mosaic");
  const idxAmount = header.indexOf("amount");
  const idxMessage = header.indexOf("message");

  const hasHeader = idxAddress !== -1 && idxMosaic !== -1 && idxAmount !== -1;
  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines.map((line) => {
    const cells = parseCsvLine(line);
    if (hasHeader) {
      return {
        address: cells[idxAddress] ?? "",
        mosaic: cells[idxMosaic] ?? "",
        amount: cells[idxAmount] ?? "",
        message: idxMessage !== -1 ? cells[idxMessage] ?? "" : "",
      };
    }
    // ヘッダーが無い場合は列順(address,mosaic,amount,message)とみなす
    return {
      address: cells[0] ?? "",
      mosaic: cells[1] ?? "",
      amount: cells[2] ?? "",
      message: cells[3] ?? "",
    };
  });
}

/* ============================================================
   mosaic文字列 → UnresolvedMosaicId(BigInt)
   16進のモザイクIDならそのまま、ドット区切りのネームスペース名なら
   generateNamespacePath で決定論的にID計算する(ネットワーク通信不要)
============================================================ */
function resolveUnresolvedMosaicIdValue(mosaicField) {
  const trimmed = mosaicField.trim();

  if (/^[0-9A-Fa-f]{16}$/.test(trimmed)) {
    return BigInt("0x" + trimmed.toUpperCase());
  }

  const path = appState.sdkSymbol.generateNamespacePath(trimmed);
  return path[path.length - 1];
}

/* ============================================================
   mosaic文字列 → divisibility (人間可読の数量をベース単位に変換するため)
============================================================ */
async function resolveDivisibility(mosaicField) {
  const trimmed = mosaicField.trim();
  const xymId = getXymMosaicIdHex();

  if (trimmed.toLowerCase() === "symbol.xym" || trimmed.toUpperCase() === xymId) {
    return 6;
  }

  if (divisibilityCache[trimmed] !== undefined) {
    return divisibilityCache[trimmed];
  }

  try {
    let mosaicIdHex;

    if (/^[0-9A-Fa-f]{16}$/.test(trimmed)) {
      mosaicIdHex = trimmed.toUpperCase();
    } else {
      // ネームスペース名 → 実際のモザイクIDをノードに問い合わせて解決
      const namespaceIdValue = resolveUnresolvedMosaicIdValue(trimmed);
      const namespaceIdHex = namespaceIdValue.toString(16).toUpperCase().padStart(16, "0");
      const nsRes = await fetch(`${appState.NODE}/namespaces/${namespaceIdHex}`).then((r) => r.json());
      if (nsRes.namespace?.alias?.mosaicId) {
        mosaicIdHex = nsRes.namespace.alias.mosaicId.toUpperCase();
      }
    }

    if (!mosaicIdHex) {
      divisibilityCache[trimmed] = 0;
      return 0;
    }

    const mosaicRes = await fetch(`${appState.NODE}/mosaics/${mosaicIdHex}`).then((r) => r.json());
    const divisibility = Number(mosaicRes.mosaic?.divisibility ?? 0);
    divisibilityCache[trimmed] = divisibility;
    return divisibility;
  } catch (e) {
    console.warn("divisibility解決失敗:", trimmed, e);
    divisibilityCache[trimmed] = 0;
    return 0;
  }
}

/* ============================================================
   複数送金の一括送信
   rows: [{ address, mosaic, amount, message }]
   すべて自分自身が送信者なので、単純な Aggregate Complete で完結する
============================================================ */
export async function sendMultiTransfer(rows) {
  if (rows.length === 0) {
    throw new Error("送金先が1件もありません。");
  }
  if (rows.length > 100) {
    throw new Error("一度に送信できるのは100件までです。");
  }

  const { descriptors, models } = appState.sdkSymbol;
  const embedded = [];

  for (const [i, row] of rows.entries()) {
    const address = row.address.trim();
    const mosaicField = row.mosaic.trim();
    const amount = Number(row.amount);

    if (!address) {
      throw new Error(`${i + 1}行目: 送金先アドレスが空です。`);
    }
    if (!mosaicField) {
      throw new Error(`${i + 1}行目: モザイクが空です。`);
    }
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`${i + 1}行目: 数量が不正です。`);
    }

    const divisibility = await resolveDivisibility(mosaicField);
    const unresolvedMosaicIdValue = resolveUnresolvedMosaicIdValue(mosaicField);

    const mosaics =
      amount > 0
        ? [
            new descriptors.UnresolvedMosaicDescriptor(
              new models.UnresolvedMosaicId(unresolvedMosaicIdValue),
              new models.Amount(BigInt(Math.round(amount * 10 ** divisibility)))
            ),
          ]
        : [];

    const messageBytes = new Uint8Array([0x00, ...new TextEncoder().encode(row.message || "")]);

    const transferDescriptor = new descriptors.TransferTransactionV1Descriptor(
      new appState.sdkSymbol.Address(address),
      mosaics,
      messageBytes
    );

    embedded.push(
      appState.facade.createEmbeddedTransactionFromTypedDescriptor(transferDescriptor, appState.currentPubKey)
    );
  }

  const aggregateDescriptor = new descriptors.AggregateCompleteTransactionV2Descriptor(
    appState.facade.static.hashEmbeddedTransactions(embedded),
    embedded
  );

  const tx = appState.facade.createTransactionFromTypedDescriptor(
    aggregateDescriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );

  return await signAndAnnounceTx(tx);
}
