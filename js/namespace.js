// namespace.js
// ネームスペースの登録(ルート/サブ・最大3階層)、更新(延長)、
// モザイク/アカウントへのリンク・解除、保有ネームスペース一覧の取得
//
// 参考: https://docs.symboltest.net/ja/textbook/namespaces/

import { appState } from "./config.js";
import { signAndAnnounceTx } from "./auth.js";

/* ============================================================
   このネームスペース自身のID(16進)を depth に応じて正しく取り出す
   depth=1→level0 / depth=2→level1 / depth=3→level2
   (level0は常に「ルート」のID。深い階層では別フィールドを見る必要がある)
============================================================ */
function ownIdOf(ns) {
  if (ns.depth === 1) return ns.level0;
  if (ns.depth === 2) return ns.level1;
  return ns.level2;
}

/* ============================================================
   保有ネームスペース一覧
============================================================ */
export async function loadOwnedNamespaces() {
  const el = document.getElementById("namespace-list");
  if (!el) return;

  el.textContent = "読み込み中...";

  try {
    const address = appState.currentAddress.toString();
    const params = new URLSearchParams({
      ownerAddress: address,
      pageSize: 100,
    });
    const res = await fetch(`${appState.NODE}/namespaces?${params}`);
    const json = await res.json();
    const items = json.data ?? [];

    if (items.length === 0) {
      el.innerHTML = `<div style="color:#94a3b8;">保有しているネームスペースはありません</div>`;
      return;
    }

    el.innerHTML = items
      .map((item) => {
        const ns = item.namespace;
        const level = ns.depth === 1 ? "ルート" : `サブ(レベル${ns.depth})`;
        const aliasType = ns.alias?.type;
        const aliasInfo =
          aliasType === 1
            ? `🔗 モザイクエイリアス: ${ns.alias.mosaicId}`
            : aliasType === 2
            ? `🔗 アドレスエイリアス: ${ns.alias.address}`
            : "エイリアスなし";

        return `
          <div class="harvest-history-item">
            <div>種別: ${level}</div>
            <div>NamespaceId: ${ownIdOf(ns)}</div>
            <div>${aliasInfo}</div>
            <div>失効高さ: ${ns.endHeight}</div>
          </div>
        `;
      })
      .join("");
  } catch (e) {
    console.error("loadOwnedNamespaces error:", e);
    el.textContent = "取得に失敗しました";
  }
}

/* ============================================================
   保有ネームスペース候補の取得(共通)
   サブネームスペース登録時の親選択、リンク対象選択などで使う。
   depth(1 or 2)も一緒に返す(depth=3は親にできないため)。
============================================================ */
export async function fetchOwnedNamespaceOptions() {
  const address = appState.currentAddress.toString();
  const params = new URLSearchParams({ ownerAddress: address, pageSize: 100 });
  const res = await fetch(`${appState.NODE}/namespaces?${params}`);
  const json = await res.json();
  const items = json.data ?? [];

  if (items.length === 0) return [];

  const ids = items.map((i) => ownIdOf(i.namespace));
  const namesRes = await fetch(`${appState.NODE}/namespaces/names`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ namespaceIds: ids }),
  }).then((r) => r.json());

  const nameMap = {};
  for (const n of namesRes || []) {
    nameMap[n.id] = n.name;
  }

  return items.map((item) => ({
    id: ownIdOf(item.namespace),
    name: nameMap[ownIdOf(item.namespace)] ?? ownIdOf(item.namespace),
    depth: item.namespace.depth,
  }));
}

/* ============================================================
   サブネームスペース登録時の親選択プルダウン
   (深さ3は親にできないため depth<3 のみ候補にする)
============================================================ */
export async function populateParentNamespaceSelect() {
  const select = document.getElementById("sub-namespace-parent-select");
  if (!select) return;

  select.innerHTML = `<option value="">-- 読み込み中... --</option>`;

  try {
    const options = await fetchOwnedNamespaceOptions();
    const eligible = options.filter((o) => o.depth < 3);

    if (eligible.length === 0) {
      select.innerHTML = `<option value="">-- 親にできるネームスペースがありません --</option>`;
      return;
    }

    select.innerHTML =
      `<option value="">-- 親ネームスペースを選択 --</option>` +
      eligible
        .map((o) => `<option value="${o.id}" data-depth="${o.depth}">${o.name}（レベル${o.depth}）</option>`)
        .join("");
  } catch (e) {
    console.warn("親ネームスペース候補の取得に失敗しました", e);
    select.innerHTML = `<option value="">-- 取得に失敗しました --</option>`;
  }
}

/* ============================================================
   ルートネームスペース登録・更新(延長)
   既に自分が所有している同名のルートネームスペースに対して再度
   実行すると、有効期間が延長される(公式仕様)。サブネームスペースは
   ルートと同じ期間を共有するため個別の更新は不要。
============================================================ */
export async function registerRootNamespace(name, durationBlocks) {
  const { descriptors, models } = appState.sdkSymbol;

  const namespaceId = new models.NamespaceId(appState.sdkSymbol.generateNamespaceId(name));

  const descriptor = new descriptors.NamespaceRegistrationTransactionV1Descriptor(
    namespaceId,
    models.NamespaceRegistrationType.ROOT,
    new models.BlockDuration(BigInt(durationBlocks)),
    undefined,
    name
  );

  const tx = appState.facade.createTransactionFromTypedDescriptor(
    descriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );

  return await signAndAnnounceTx(tx);
}

/* ============================================================
   サブネームスペース登録(最大3階層目まで)
============================================================ */
export async function registerSubNamespace(parentIdHex, subName) {
  const { descriptors, models } = appState.sdkSymbol;

  const parentId = new models.NamespaceId(BigInt("0x" + parentIdHex));
  const namespaceId = new models.NamespaceId(
    appState.sdkSymbol.generateNamespaceId(subName, parentId.value)
  );

  const descriptor = new descriptors.NamespaceRegistrationTransactionV1Descriptor(
    namespaceId,
    models.NamespaceRegistrationType.CHILD,
    undefined,
    parentId,
    subName
  );

  const tx = appState.facade.createTransactionFromTypedDescriptor(
    descriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );

  return await signAndAnnounceTx(tx);
}

/* ============================================================
   ネームスペース ⇔ アカウント のリンク/解除
   (モザイクへのリンクは mosaic.js 側にある)
   ※ リンク先アカウント自身がAccountOperationRestrictionで
     AddressAliasTransactionをブロックしていると失敗する(仕様通り)。
============================================================ */
export async function setAddressAlias(namespaceIdHex, targetAddress, action) {
  const { descriptors, models } = appState.sdkSymbol;

  const namespaceId = new models.NamespaceId(BigInt("0x" + namespaceIdHex));
  const address = new appState.sdkSymbol.Address(targetAddress);
  const aliasAction = action === "unlink" ? models.AliasAction.UNLINK : models.AliasAction.LINK;

  const descriptor = new descriptors.AddressAliasTransactionV1Descriptor(namespaceId, address, aliasAction);

  const tx = appState.facade.createTransactionFromTypedDescriptor(
    descriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );

  return await signAndAnnounceTx(tx);
}
