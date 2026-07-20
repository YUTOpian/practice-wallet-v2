// mosaic.js
// モザイクの作成・自分が保有するモザイク一覧(ネームスペースとのリンク状況付き)の取得

import { appState } from "./config.js";
import { setStatus } from "./ui.js";
import { formatMosaicAmount } from "./utils.js";
import { signAndAnnounceTx } from "./auth.js";

/* ============================================================
   保有モザイク一覧 + ネームスペースリンク状況
   (account.js の appState.mosaicInfo をベースに、
    まだ解決していないモザイクのエイリアス名を追加取得する)
============================================================ */
/* ============================================================
   保有ネームスペース候補の取得 (共通)
============================================================ */
async function fetchOwnedNamespaceOptions() {
  const address = appState.currentAddress.toString();
  const params = new URLSearchParams({ ownerAddress: address, pageSize: 100 });
  const res = await fetch(`${appState.NODE}/namespaces?${params}`);
  const json = await res.json();
  const items = json.data ?? [];

  if (items.length === 0) return [];

  const ids = items.map((i) => i.namespace.level0 ?? i.namespace.id);
  const namesRes = await fetch(`${appState.NODE}/namespaces/names`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ namespaceIds: ids }),
  }).then((r) => r.json());

  const nameMap = {};
  for (const n of namesRes || []) {
    nameMap[n.id] = n.name;
  }

  return ids.map((id) => ({ id, name: nameMap[id] ?? id }));
}

/* ============================================================
   自分が作成した(オーナーになっている)モザイク一覧 + ネームスペースリンク状況
   保有量(mosaicInfo)ではなく、/mosaics?ownerAddress= で
   「自分が定義者になっているモザイク」を取得する。
   リンクされていないモザイクには、その場でネームスペースを
   選んでリンクできる操作を表示する。
============================================================ */
export async function loadOwnedMosaicsWithAlias() {
  const el = document.getElementById("owned-mosaic-list");
  if (!el) return;

  el.textContent = "読み込み中...";

  try {
    const address = appState.currentAddress.toString();
    const params = new URLSearchParams({ ownerAddress: address, pageSize: 100 });
    const res = await fetch(`${appState.NODE}/mosaics?${params}`);
    const json = await res.json();
    const mosaicItems = json.data ?? [];

    if (mosaicItems.length === 0) {
      el.innerHTML = `<div style="color:#94a3b8;">作成したモザイクはありません</div>`;
      return;
    }

    const ids = mosaicItems.map((item) => item.mosaic.id.toUpperCase());

    const [namesRes, namespaceOptions] = await Promise.all([
      fetch(`${appState.NODE}/namespaces/mosaic/names`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mosaicIds: ids }),
      }).then((r) => r.json()),
      fetchOwnedNamespaceOptions().catch(() => []),
    ]);

    const aliasMap = {};
    for (const item of namesRes.mosaicNames || []) {
      const mosaicId = item.mosaicId.toUpperCase();
      if (item.names && item.names.length > 0) {
        const first = item.names[0];
        aliasMap[mosaicId] = typeof first === "string" ? first : first?.name;
      }
    }

    const namespaceOptionsHtml = namespaceOptions
      .map((ns) => `<option value="${ns.id}">${ns.name}</option>`)
      .join("");

    el.innerHTML = mosaicItems
      .map((item) => {
        const m = item.mosaic;
        const id = m.id.toUpperCase();
        const alias = aliasMap[id];
        const divisibility = Number(m.divisibility ?? 0);
        const supply = m.supply != null ? formatMosaicAmount(m.supply, divisibility) : "---";

        const flags = m.flags ?? 0;
        const flagLabels = [];
        if (flags & 0x1) flagLabels.push("supplyMutable");
        if (flags & 0x2) flagLabels.push("transferable");
        if (flags & 0x4) flagLabels.push("restrictable");
        if (flags & 0x8) flagLabels.push("revokable");

        const linkControlHtml = alias
          ? ""
          : namespaceOptions.length === 0
          ? `<div style="font-size:12px;color:#94a3b8;">(先にネームスペースを登録するとリンクできます)</div>`
          : `
            <div class="mosaic-link-row">
              <select class="input-box mosaic-link-select" data-mosaic-id="${id}">
                <option value="">-- ネームスペースを選択 --</option>
                ${namespaceOptionsHtml}
              </select>
              <button class="account-hide-btn" data-action="link-mosaic" data-mosaic-id="${id}">リンクする</button>
            </div>
          `;

        return `
          <div class="harvest-history-item">
            <div>モザイクID: ${id}</div>
            <div>供給量: ${supply}</div>
            <div>可分性: ${divisibility}</div>
            <div>フラグ: ${flagLabels.length ? flagLabels.join(", ") : "なし"}</div>
            <div>${alias ? `🔗 ネームスペース: ${alias}` : "ネームスペースとのリンクなし"}</div>
            ${linkControlHtml}
          </div>
        `;
      })
      .join("");
  } catch (e) {
    console.error("loadOwnedMosaicsWithAlias error:", e);
    el.textContent = "取得に失敗しました";
  }
}

/* ============================================================
   モザイク作成用: 保有ネームスペース候補(リンク先選択)
============================================================ */
export async function populateMosaicNamespaceSelect() {
  const select = document.getElementById("mosaic-link-namespace-select");
  if (!select) return;

  select.innerHTML = `<option value="">-- リンクしない --</option>`;

  try {
    const options = await fetchOwnedNamespaceOptions();
    select.innerHTML += options.map((ns) => `<option value="${ns.id}">${ns.name}</option>`).join("");
  } catch (e) {
    console.warn("ネームスペース候補の取得に失敗しました", e);
  }
}

/* ============================================================
   作成済みモザイクを後からネームスペースにリンクする
============================================================ */
export async function linkNamespaceToMosaic(mosaicIdHex, namespaceIdHex) {
  const { descriptors, models } = appState.sdkSymbol;

  const namespaceId = new models.NamespaceId(BigInt("0x" + namespaceIdHex));
  const mosaicId = new models.MosaicId(BigInt("0x" + mosaicIdHex));

  const aliasDescriptor = new descriptors.MosaicAliasTransactionV1Descriptor(
    namespaceId,
    mosaicId,
    models.AliasAction.LINK
  );

  const tx = appState.facade.createTransactionFromTypedDescriptor(
    aliasDescriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );

  return await signAndAnnounceTx(tx);
}

/* ============================================================
   モザイク作成
============================================================ */
export async function createMosaic({
  divisibility,
  durationBlocks,
  supplyMutable,
  transferable,
  restrictable,
  initialSupply,
  linkNamespaceIdHex,
}) {
  const { descriptors, models } = appState.sdkSymbol;

  // ナンス(4byte)をランダム生成
  const nonceBytes = new Uint8Array(4);
  crypto.getRandomValues(nonceBytes);
  const nonceValue =
    nonceBytes[0] + nonceBytes[1] * 0x100 + nonceBytes[2] * 0x10000 + nonceBytes[3] * 0x1000000;
  const nonce = new models.MosaicNonce(nonceValue);

  const mosaicIdValue = appState.sdkSymbol.generateMosaicId(appState.currentAddress, nonceValue);
  const mosaicId = new models.MosaicId(mosaicIdValue);

  let flagValue = models.MosaicFlags.NONE.value;
  if (supplyMutable) flagValue += models.MosaicFlags.SUPPLY_MUTABLE.value;
  if (transferable) flagValue += models.MosaicFlags.TRANSFERABLE.value;
  if (restrictable) flagValue += models.MosaicFlags.RESTRICTABLE.value;
  const flags = new models.MosaicFlags(flagValue);

  const definitionDescriptor = new descriptors.MosaicDefinitionTransactionV1Descriptor(
    mosaicId,
    new models.BlockDuration(BigInt(durationBlocks)),
    nonce,
    flags,
    divisibility
  );

  const embedded = [
    appState.facade.createEmbeddedTransactionFromTypedDescriptor(
      definitionDescriptor,
      appState.currentPubKey
    ),
  ];

  if (initialSupply > 0) {
    const supplyDescriptor = new descriptors.MosaicSupplyChangeTransactionV1Descriptor(
      new models.UnresolvedMosaicId(mosaicIdValue),
      new models.Amount(BigInt(Math.floor(initialSupply * 10 ** divisibility))),
      models.MosaicSupplyChangeAction.INCREASE
    );
    embedded.push(
      appState.facade.createEmbeddedTransactionFromTypedDescriptor(
        supplyDescriptor,
        appState.currentPubKey
      )
    );
  }

  if (linkNamespaceIdHex) {
    const namespaceId = new models.NamespaceId(BigInt("0x" + linkNamespaceIdHex));
    const aliasDescriptor = new descriptors.MosaicAliasTransactionV1Descriptor(
      namespaceId,
      mosaicId,
      models.AliasAction.LINK
    );
    embedded.push(
      appState.facade.createEmbeddedTransactionFromTypedDescriptor(
        aliasDescriptor,
        appState.currentPubKey
      )
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
