// 공모주 일정 자동 수집 스크립트 (Node 20 이상, 외부 패키지 없음)
//
// 실행: node scripts/update-ipos.mjs
// 환경변수: DART_API_KEY (선택) - 없으면 KIND만으로 수집해요.
//
// 1) KIND(한국거래소 공시채널) 공모기업현황: 청약일·납입(환불)일·확정공모가·상장예정일·주관사, 상세에서 희망공모가·일반투자자 배정주식수
// 2) DART 오픈API(선택): KIND에 아직 안 올라온 비상장사 증권신고서(지분증권) → 청약일·납입일·모집가액·인수인
// 3) 이전 데이터(data/ipos.json)와 수동 보정(data/overrides.json)을 합쳐 data/ipos.json, src/data/ipos.json 에 저장해요.
// 수집이 전부 실패하면 기존 파일을 건드리지 않고 오류로 끝나요. (GitHub Actions가 메일로 알려줘요)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KIND = "https://kind.krx.co.kr";
const DART = "https://opendart.fss.or.kr/api";
const UA = { "User-Agent": "Mozilla/5.0 (ipo-calendar data updater)" };
const KEEP_AFTER_SUBSCRIPTION_DAYS = 30; // 청약 끝나고 30일까지 유지
const KEEP_AFTER_LISTING_DAYS = 14; // 상장 후 14일까지 유지

// ---------- 공통 유틸 ----------

export function kstToday(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  return kst.toISOString().slice(0, 10);
}

export function addDays(dateKey, days) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function plain(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** "2026년 11월 02일", "2026.11.02", "2026-11-02" 등에서 날짜들을 YYYY-MM-DD로 뽑아요 */
export function extractDates(text) {
  if (!text) return [];
  const out = [];
  for (const m of String(text).matchAll(/(\d{4})\s*[.\-년/]\s*(\d{1,2})\s*[.\-월/]\s*(\d{1,2})/g)) {
    out.push(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`);
  }
  return out;
}

export function toNum(text) {
  if (text == null) return null;
  const digits = String(text).replace(/[^0-9]/g, "");
  return digits ? Number(digits) : null;
}

/** 회사명 비교용: 공백·(주)·주식회사 제거 */
export function normName(name) {
  return String(name)
    .replace(/\(주\)|㈜|주식회사/g, "")
    .replace(/\s+/g, "")
    .trim();
}

const BROKER_ALIASES = [
  [/엔에이치투자증권/g, "NH투자증권"],
  [/케이비증권/g, "KB증권"],
  [/아이비케이투자증권/g, "IBK투자증권"],
  [/에스케이증권/g, "SK증권"],
  [/디비금융투자|디비증권/g, "DB증권"],
  [/아이엠증권/g, "iM증권"],
];

export function normBroker(name) {
  let n = String(name).replace(/\(주\)|㈜|주식회사/g, "").replace(/\s+/g, "").trim();
  for (const [re, to] of BROKER_ALIASES) n = n.replace(re, to);
  // "-" 처럼 빈 표기는 증권사로 치지 않아요
  return /[가-힣A-Za-z]/.test(n) ? n : "";
}

async function getText(url, init = {}, fetchImpl = fetch, retries = 2) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetchImpl(url, { ...init, headers: { ...UA, ...(init.headers ?? {}) } });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.text();
    } catch (error) {
      if (i >= retries) throw error;
      await sleep(1000 * (i + 1));
    }
  }
}

// ---------- KIND ----------

/** KIND 공모기업현황 목록 HTML → 행 배열 */
export function parseKindList(html) {
  const rows = [];
  for (const m of html.matchAll(/<tr[^>]*fnDetailView\('(\d+)'\)[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells.length < 9) continue;
    const market = /alt='([^']+)'/.exec(cells[0])?.[1] ?? null;
    const [sub1, sub2] = extractDates(plain(cells[3]));
    rows.push({
      kindId: m[1],
      name: plain(cells[0]),
      market: market === "코스닥" ? "KOSDAQ" : market === "유가증권" ? "KOSPI" : market === "코넥스" ? "KONEX" : market,
      filedAt: extractDates(plain(cells[1]))[0] ?? null,
      subscriptionStart: sub1 ?? null,
      subscriptionEnd: sub2 ?? sub1 ?? null,
      refundDate: extractDates(plain(cells[4]))[0] ?? null,
      finalPrice: toNum(plain(cells[5])),
      listingDate: extractDates(plain(cells[7]))[0] ?? null,
      brokers: plain(cells[8])
        .split(/[,，]/)
        .map((b) => normBroker(b))
        .filter(Boolean),
    });
  }
  return rows;
}

/** KIND 공모기업 상세 → 희망공모가·일반투자자 배정·업종·주요제품 */
export function parseKindDetail(html) {
  const t = plain(html);
  const band = /희망공모가격\s*([\d,]+)\s*~\s*([\d,]+)/.exec(t);
  const retail = /일반투자자\s*([\d,]+)/.exec(t);
  const total = /총액\s*([\d,]+)/.exec(t);
  const industry = /업종\s*(.+?)\s*주요제품/.exec(t)?.[1]?.trim();
  const products = /주요제품\s*(.+?)\s*본점소재지/.exec(t)?.[1]?.trim();
  return {
    bandLow: band ? toNum(band[1]) : null,
    bandHigh: band ? toNum(band[2]) : null,
    retailShares: retail ? toNum(retail[1]) : null,
    totalShares: total ? toNum(total[1]) : null,
    summary: [industry, products].filter((s) => s && s !== "-").join(" · ") || null,
  };
}

export async function fetchKind({ today, fetchImpl = fetch, log = console.log }) {
  const rows = [];
  for (let page = 1; page <= 10; page++) {
    const body = new URLSearchParams({
      method: "searchPubofrProgComSub",
      forward: "pubofrprogcom_sub",
      currentPageSize: "100",
      pageIndex: String(page),
      orderMode: "1",
      orderStat: "D",
      marketType: "",
      searchCorpName: "",
      fromDate: addDays(today, -200), // 신고서 제출일 기준
      toDate: today,
    });
    const html = await getText(
      `${KIND}/listinvstg/pubofrprogcom.do`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
        body: body.toString(),
      },
      fetchImpl,
    );
    const pageRows = parseKindList(html);
    rows.push(...pageRows);
    if (pageRows.length < 100) break;
  }
  log(`KIND 목록 ${rows.length}건`);

  const items = [];
  for (const row of rows.filter((r) => inWindow(r, today))) {
    let detail = {};
    try {
      detail = parseKindDetail(
        await getText(`${KIND}/listinvstg/pubofrprogcomdetail.do?method=searchProgComDetailMain&bzProcsNo=${row.kindId}`, {}, fetchImpl),
      );
    } catch (error) {
      log(`KIND 상세 실패 ${row.name}: ${error.message}`);
    }
    items.push({ ...row, ...detail, source: "KIND" });
    await sleep(300);
  }
  log(`KIND 수집 ${items.length}건 (기간 내)`);
  return items;
}

// ---------- DART (선택) ----------

async function dartJson(endpoint, params, fetchImpl) {
  const qs = new URLSearchParams(params).toString();
  return JSON.parse(await getText(`${DART}/${endpoint}?${qs}`, {}, fetchImpl));
}

/** estkRs 응답(그룹 목록)에서 필요한 값만 뽑아요 */
export function parseEstkRs(json) {
  const groups = Array.isArray(json?.group) ? json.group : [];
  const byTitle = (title) => groups.find((g) => String(g.title ?? "").includes(title))?.list ?? [];
  const general = byTitle("일반사항").at(-1) ?? {};
  const kinds = byTitle("증권의종류");
  const stock = kinds.at(-1) ?? {};
  const underwriters = byTitle("인수인");
  const latestRcept = general.rcept_no;
  const brokersAll = underwriters.filter((u) => !latestRcept || u.rcept_no === latestRcept);
  const leads = brokersAll.filter((u) => /대표|공동/.test(String(u.actsen ?? "")));
  const [sub1, sub2] = extractDates(general.sbd);
  return {
    name: general.corp_name ?? stock.corp_name ?? null,
    subscriptionStart: sub1 ?? null,
    subscriptionEnd: sub2 ?? sub1 ?? null,
    refundDate: extractDates(general.pymd)[0] ?? null, // 납입기일 = 환불일
    price: toNum(stock.slprc),
    totalShares: toNum(stock.stkcnt),
    brokers: [...new Set((leads.length ? leads : brokersAll).map((u) => normBroker(u.actnmn)).filter(Boolean))],
  };
}

export async function fetchDart({ today, key, fetchImpl = fetch, log = console.log }) {
  const bgn = addDays(today, -170).replace(/-/g, "");
  const end = today.replace(/-/g, "");
  const filings = [];
  // 회사를 지정하지 않은 공시 검색은 한 번에 3개월까지만 돼요 → 85일씩 두 구간으로 나눠 조회
  const windows = [
    [addDays(today, -170), addDays(today, -86)],
    [addDays(today, -85), today],
  ];
  for (const [from, to] of windows) {
    for (let page = 1; page <= 10; page++) {
      const res = await dartJson(
        "list.json",
        {
          crtfc_key: key,
          bgn_de: from.replace(/-/g, ""),
          end_de: to.replace(/-/g, ""),
          pblntf_detail_ty: "C001",
          page_no: String(page),
          page_count: "100",
        },
        fetchImpl,
      );
      if (res.status === "013") break; // 조회된 데이터 없음
      if (res.status !== "000") throw new Error(`DART list ${res.status} ${res.message}`);
      filings.push(...(res.list ?? []));
      if (page >= Number(res.total_page ?? 1)) break;
    }
  }
  // 최신 접수분이 앞에 오도록 정렬 (같은 회사는 최신 신고서 기준)
  filings.sort((a, b) => String(b.rcept_dt ?? "").localeCompare(String(a.rcept_dt ?? "")));
  // 비상장사(E)의 지분증권 신고서 = 공모주 후보 (상장사 유상증자 제외)
  const corps = new Map();
  for (const f of filings) if (f.corp_cls === "E" && !corps.has(f.corp_code)) corps.set(f.corp_code, f.corp_name);
  log(`DART 신고서 ${filings.length}건, 비상장사 ${corps.size}곳`);

  const items = [];
  for (const [corpCode, corpName] of corps) {
    try {
      const res = await dartJson("estkRs.json", { crtfc_key: key, corp_code: corpCode, bgn_de: bgn, end_de: end }, fetchImpl);
      if (res.status !== "000") continue;
      const p = parseEstkRs(res);
      if (!p.subscriptionStart) continue;
      // 주관(인수) 증권사가 없으면 일반인이 청약하는 공모주가 아니에요 (기존주주·해외 모집 등)
      if (p.brokers.length === 0) continue;
      items.push({
        name: p.name ?? corpName,
        market: null,
        subscriptionStart: p.subscriptionStart,
        subscriptionEnd: p.subscriptionEnd,
        refundDate: p.refundDate,
        listingDate: null,
        finalPrice: null,
        bandLow: p.price, // 신고서의 모집가액 (확정 전에는 희망가 하단)
        bandHigh: null,
        brokers: p.brokers,
        totalShares: p.totalShares,
        // 일반청약자 배정은 통상 공모주식의 25~30% → KIND 값이 없을 때만 추정치로 써요
        retailShares: p.totalShares ? Math.round(p.totalShares * 0.25) : null,
        retailSharesMax: p.totalShares ? Math.round(p.totalShares * 0.3) : undefined,
        retailEstimated: Boolean(p.totalShares),
        source: "DART",
      });
    } catch (error) {
      log(`DART 상세 실패 ${corpName}: ${error.message}`);
    }
    await sleep(200);
  }
  log(`DART 수집 ${items.filter((i) => inWindow(i, today)).length}건 (기간 내)`);
  return items.filter((i) => inWindow(i, today));
}

// ---------- 합치기 ----------

export function inWindow(item, today) {
  const subEnd = item.subscriptionEnd ?? item.subscriptionStart;
  if (item.listingDate && item.listingDate >= addDays(today, -KEEP_AFTER_LISTING_DAYS)) return true;
  if (subEnd && subEnd >= addDays(today, -KEEP_AFTER_SUBSCRIPTION_DAYS)) return true;
  if (!subEnd && !item.listingDate) return Boolean(item.filedAt && item.filedAt >= addDays(today, -60));
  return false;
}

function sameIpo(a, b) {
  const na = normName(a.name);
  const nb = normName(b.name);
  if (na === nb) return true;
  if (!a.subscriptionStart || a.subscriptionStart !== b.subscriptionStart) return false;
  // "엘리스" vs "엘리스그룹"처럼 이름이 조금 달라도 청약 시작일이 같으면 같은 종목으로 봐요
  if (na.includes(nb) || nb.includes(na)) return true;
  // "한화플러스제6호스팩" vs "한화플러스스팩6호"처럼 표기가 다르면: 청약 기간·증권사가 같고 숫자가 같으면 같은 종목
  const sameEnd = (a.subscriptionEnd ?? a.subscriptionStart) === (b.subscriptionEnd ?? b.subscriptionStart);
  const brokerOverlap = (a.brokers ?? []).some((x) => (b.brokers ?? []).includes(x));
  const digits = (s) => s.replace(/[^0-9]/g, "");
  return sameEnd && brokerOverlap && digits(na) === digits(nb);
}

function pick(...values) {
  for (const v of values) if (v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)) return v;
  return null;
}

/** KIND 우선, 빈 값은 DART → 이전 데이터 순으로 채워요. 수동 보정은 마지막에 덮어써요. */
export function mergeIpos({ kind, dart, previous, overrides = {}, today }) {
  const merged = [];
  const used = new Set();
  const prevItems = previous?.items ?? [];

  const findPrev = (item) => prevItems.find((p) => sameIpo(p, item));

  for (const k of kind) {
    const d = dart.find((x) => sameIpo(x, k));
    if (d) used.add(d);
    const p = findPrev(k);
    const hasKindRetail = k.retailShares != null;
    merged.push({
      id: p?.id ?? normName(k.name),
      name: k.name,
      market: pick(k.market, p?.market),
      subscriptionStart: pick(k.subscriptionStart, d?.subscriptionStart, p?.subscriptionStart),
      subscriptionEnd: pick(k.subscriptionEnd, d?.subscriptionEnd, p?.subscriptionEnd),
      refundDate: pick(k.refundDate, d?.refundDate, p?.refundDate),
      listingDate: pick(k.listingDate, p?.listingDate),
      finalPrice: pick(k.finalPrice, p?.finalPrice),
      bandLow: pick(k.bandLow, p?.bandLow, d?.bandLow),
      bandHigh: pick(k.bandHigh, p?.bandHigh),
      minQty: pick(p?.minQty),
      brokers: pick(k.brokers, d?.brokers, p?.brokers) ?? [],
      retailShares: pick(k.retailShares, p?.retailShares, d?.retailShares),
      ...(hasKindRetail ? {} : pick(p?.retailSharesMax, d?.retailSharesMax) ? { retailSharesMax: pick(p?.retailSharesMax, d?.retailSharesMax) } : {}),
      ...(!hasKindRetail && (p?.retailEstimated || d?.retailEstimated) ? { retailEstimated: true } : {}),
      totalShares: pick(k.totalShares, d?.totalShares, p?.totalShares),
      summary: pick(p?.summary, k.summary),
    });
  }

  for (const d of dart) {
    if (used.has(d) || merged.some((m) => sameIpo(m, d))) continue;
    const p = findPrev(d);
    merged.push({
      id: p?.id ?? normName(d.name),
      name: pick(p?.name, d.name),
      market: pick(p?.market, d.market),
      subscriptionStart: pick(d.subscriptionStart, p?.subscriptionStart),
      subscriptionEnd: pick(d.subscriptionEnd, p?.subscriptionEnd),
      refundDate: pick(d.refundDate, p?.refundDate),
      listingDate: pick(p?.listingDate),
      finalPrice: pick(p?.finalPrice),
      bandLow: pick(p?.bandLow, d.bandLow),
      bandHigh: pick(p?.bandHigh),
      minQty: pick(p?.minQty),
      brokers: pick(d.brokers, p?.brokers) ?? [],
      retailShares: pick(p?.retailShares, d.retailShares),
      ...(pick(p?.retailSharesMax, d.retailSharesMax) ? { retailSharesMax: pick(p?.retailSharesMax, d.retailSharesMax) } : {}),
      ...(d.retailEstimated && !p?.retailShares ? { retailEstimated: true } : {}),
      totalShares: pick(d.totalShares, p?.totalShares),
      summary: pick(p?.summary),
    });
  }

  // 새 수집에 없어도 기간 안의 이전 종목은 유지해요 (수집처 일시 장애 대비)
  for (const p of prevItems) {
    if (merged.some((m) => sameIpo(m, p))) continue;
    if (inWindow(p, today)) merged.push(p);
  }

  const result = merged
    .filter((m) => inWindow(m, today))
    // 청약 증권사가 없는 항목은 일반 청약 공모주가 아니라서 빼요 (이전 데이터에 남아 있어도)
    .map((m) => ({ ...m, brokers: (m.brokers ?? []).filter((b) => /[가-힣A-Za-z]/.test(String(b))) }))
    .filter((m) => m.brokers.length > 0)
    .map((m) => {
      const o = overrides[m.id] ?? overrides[m.name] ?? {};
      const item = { ...m, ...o };
      // 스팩처럼 희망가 범위가 한 가격뿐이면 그 가격이 공모가예요
      if (!item.finalPrice && item.bandLow && item.bandLow === item.bandHigh) item.finalPrice = item.bandLow;
      item.status = item.finalPrice ? "confirmed" : "tentative";
      if (item.finalPrice && item.retailSharesMax && !item.retailEstimated) delete item.retailSharesMax;
      return item;
    })
    .sort((a, b) => (a.subscriptionStart ?? "9").localeCompare(b.subscriptionStart ?? "9"));

  return result;
}

// ---------- 실행 ----------

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataFile = path.join(root, "data", "ipos.json");
  const appFile = path.join(root, "src", "data", "ipos.json");
  const overridesFile = path.join(root, "data", "overrides.json");
  const today = kstToday();

  const previous = (await readJson(dataFile, null)) ?? (await readJson(appFile, { items: [] }));
  const overrides = await readJson(overridesFile, {});

  let kind = [];
  let dart = [];
  const errors = [];
  try {
    kind = await fetchKind({ today });
  } catch (error) {
    errors.push(`KIND: ${error.message}`);
  }
  if (process.env.DART_API_KEY) {
    try {
      dart = await fetchDart({ today, key: process.env.DART_API_KEY });
    } catch (error) {
      errors.push(`DART: ${error.message}`);
    }
  } else {
    console.log("DART_API_KEY가 없어서 DART 수집은 건너뛰어요");
  }

  if (kind.length === 0 && dart.length === 0) {
    console.error("수집된 종목이 없어서 기존 파일을 유지해요.", errors.join(" / "));
    process.exit(1);
  }
  if (errors.length) console.warn("일부 수집 실패:", errors.join(" / "));

  const items = mergeIpos({ kind, dart, previous, overrides, today });
  const sources = ["KIND(한국거래소) 공모기업현황", dart.length ? "DART 증권신고서" : null].filter(Boolean).join(", ");
  const out = { updatedAt: today, source: `${sources} 자동 수집`, items };
  const json = `${JSON.stringify(out, null, 2)}\n`;
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  await fs.writeFile(dataFile, json);
  // 앱 소스가 같이 있는 폴더(내 PC)에서 돌릴 때만 앱 내장 데이터도 갱신해요. (데이터 전용 저장소에는 src가 없어요)
  const hasAppSource = await fs
    .stat(path.join(root, "src"))
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (hasAppSource) {
    await fs.mkdir(path.dirname(appFile), { recursive: true });
    await fs.writeFile(appFile, json);
  }
  console.log(`저장 완료: ${items.length}개 종목 (${today})`);
}

if (!globalThis.__IPO_SCRIPT_TEST__) {
  await main();
}
