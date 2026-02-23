// 2025.01 인터넷등기소 개편 이후 최신 Tilko API 테스트
// 테스트 지역: 경기도 오산시, 부산광역시 기장군 각 1곳 (주택/아파트 지역)
import crypto from 'crypto';
import { readFileSync } from 'fs';

const envContent = readFileSync('.env', 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const [key, ...vals] = line.split('=');
  if (key && vals.length) env[key.trim()] = vals.join('=').trim();
});

const { VWORLD_API_KEY, TILKO_API_KEY, IROS_USER_ID, IROS_USER_PASSWORD, EMONEY_NO1, EMONEY_NO2, EMONEY_PWD } = env;

const apiHost = "https://api.tilko.net";

// 주택/아파트 지역 좌표로 변경 (특수 토지 필지 회피)
const TEST_LOCATIONS = [
  { label: "경기도 오산시 (원동 주택가)", lat: 37.1430, lng: 127.0670 },
  { label: "부산광역시 기장군 (기장읍 내리 시가지)", lat: 35.2473, lng: 129.2190 },
];

function aesEncrypt(key, iv, plainText) {
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  let ret = cipher.update(plainText, "utf8", "base64");
  ret += cipher.final("base64");
  return ret;
}

function rsaEncrypt(publicKeyBase64, aesKey) {
  const pemKey = "-----BEGIN PUBLIC KEY-----\n" + publicKeyBase64 + "\n-----END PUBLIC KEY-----";
  const encrypted = crypto.publicEncrypt(
    { key: pemKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    aesKey
  );
  return encrypted.toString("base64");
}

async function getPublicKey() {
  const res = await fetch(`${apiHost}/api/Auth/GetPublicKey?APIkey=${TILKO_API_KEY}`);
  const json = await res.json();
  return json.PublicKey;
}

async function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function testLocation(label, lat, lng, rsaPublicKey) {
  const aesIv = Buffer.alloc(16, 0);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`테스트 지역: ${label}`);
  console.log(`좌표: lat=${lat}, lng=${lng}`);
  console.log("=".repeat(60));

  // Step 1. VWorld 역지오코딩 → 지번주소
  console.log("\n[1단계] VWorld 지번주소 조회");
  const pnuUrl = `https://api.vworld.kr/req/address?service=address&request=getAddress&version=2.0&crs=EPSG:4326&point=${lng},${lat}&type=PARCEL&format=json&key=${VWORLD_API_KEY}`;
  const pnuRes = await fetch(pnuUrl);
  const pnuJson = await pnuRes.json();

  if (pnuJson.response.status !== 'OK' || !pnuJson.response.result) {
    console.log("  결과: 주소 조회 실패 -", pnuJson.response.status);
    return;
  }
  const jibunAddr = pnuJson.response.result[0].text;
  console.log("  지번주소:", jibunAddr);

  // Step 2. 고유번호 검색 (Address 평문 전달 - 틸코 기술지원 확인)
  console.log("\n[2단계] 고유번호 검색 (RetrieveSmplSrchList)");
  const searchAesKey = crypto.randomBytes(16);
  const searchEncKey = rsaEncrypt(rsaPublicKey, searchAesKey);
  const searchRes = await fetchWithTimeout(`${apiHost}/api/v2.0/Iros2/RetrieveSmplSrchList`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "API-KEY": TILKO_API_KEY, "ENC-KEY": searchEncKey },
    body: JSON.stringify({ Address: jibunAddr }),
  });
  const searchJson = await searchRes.json();
  console.log("  HTTP Status:", searchRes.status, "/ Message:", searchJson.Message);

  const isSuccess = searchJson.Status === 'Success' || searchJson.Message === 'OK' || searchJson.Message === '성공';
  if (!isSuccess) {
    console.log("  오류:", JSON.stringify(searchJson, null, 2).substring(0, 400));
    return;
  }

  const dataList = (searchJson.Result && searchJson.Result.DataList) || searchJson.DataList || [];
  if (dataList.length === 0) {
    console.log("  결과: 고유번호 0건");
    return;
  }

  console.log(`  고유번호 ${dataList.length}건 발견`);
  dataList.forEach((item, i) => {
    const status = item.pin_mid_spe_yn === 'Y' ? '[특수필지]' : '';
    console.log(`    [${i}] pin=${item.pin} | pin_land=${item.pin_land} | 구분=${item.real_cls_cd} | 주소=${item.real_indi_cont} ${status}`);
  });

  // 집합건물 > 건물 > 토지 순으로 우선 선택, 특수필지 제외
  const normalItems = dataList.filter(item => item.pin_mid_spe_yn !== 'Y');
  const normalItem = normalItems.find(item => item.real_cls_cd === '집합건물')
    || normalItems.find(item => item.real_cls_cd === '건물')
    || normalItems[0]
    || dataList[0];
  const pin = normalItem.pin || normalItem.wk_pin || '';

  if (!pin) {
    console.log("  Pin 추출 실패");
    return;
  }
  console.log(`  선택된 Pin: ${pin} (${normalItem.real_cls_cd} / ${normalItem.real_indi_cont})`);

  if (normalItem.pin_mid_spe_yn === 'Y') {
    console.log("  ⚠ 주의: 특수필지 (pin_mid_spe_yn=Y) - 등기부 조회 불가할 수 있음");
  }

  // Step 3. 등기부등본 조회 (비용 발생)
  console.log("\n[3단계] 등기부등본 조회 (RealtyRegistry) ← 비용 발생");
  const freshKey = await getPublicKey();
  const aesKey = crypto.randomBytes(16);
  const encKey = rsaEncrypt(freshKey, aesKey);

  let regRes;
  try {
    regRes = await fetchWithTimeout(`${apiHost}/api/v2.0/Iros2IdLogin/RealtyRegistry`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "API-KEY": TILKO_API_KEY, "ENC-KEY": encKey },
      body: JSON.stringify({
        Auth: {
          UserId: aesEncrypt(aesKey, aesIv, IROS_USER_ID),
          UserPassword: aesEncrypt(aesKey, aesIv, IROS_USER_PASSWORD),
        },
        Pin: pin,  // 평문 전달 (틸코 기술지원 확인)
        EmoneyNo1: aesEncrypt(aesKey, aesIv, EMONEY_NO1),
        EmoneyNo2: aesEncrypt(aesKey, aesIv, EMONEY_NO2),
        EmoneyPwd: aesEncrypt(aesKey, aesIv, EMONEY_PWD),
      }),
    }, 150000); // 97초 걸리는 것 확인됨 → 150초로 증가
  } catch (err) {
    console.log("  네트워크 오류:", err.message);
    return;
  }

  const regJson = await regRes.json();
  console.log("  HTTP Status:", regRes.status, "/ Message:", regJson.Message);
  if (regJson.PointBalance !== undefined) console.log("  잔액:", regJson.PointBalance, "원");

  const regOk = regJson.Message === 'OK' || regJson.Message === '성공' || regJson.Status === 'Success';
  if (!regOk) {
    console.log("  ErrorCode:", regJson.ErrorCode);
    console.log("  ErrorLog:", regJson.ErrorLog);
    return;
  }

  const xmlData = regJson.XmlData || '';

  // 소유주 + 소유자 주소: 가장 마지막 갑구(type=K) 소유자 항목에서 추출
  // 형식: "소유자  이름  번호\n    주소"
  const ownerBlocks = [...xmlData.matchAll(/<wksbk_nomprs_and_etc><!\[CDATA\[([\s\S]*?)\]\]><\/wksbk_nomprs_and_etc>/g)];
  const lastOwnerBlock = [...ownerBlocks].reverse().find(m => m[1].includes('소유자'));
  const ownerName = lastOwnerBlock ? (lastOwnerBlock[1].match(/소유자\s+([^\s]+)/) || [])[1] : undefined;
  const ownerAddr = lastOwnerBlock ? (lastOwnerBlock[1].match(/소유자\s+[^\n]+\n\s*([^\n]+)/) || [])[1]?.trim() : undefined;

  console.log("\n  ┌─── 등기부등본 결과 ───────────────────────");
  console.log("  │ 소유주   :", ownerName || '정보 없음');
  console.log("  │ 소유자주소:", ownerAddr || '정보 없음');
  console.log("  └───────────────────────────────────────────");
}

(async () => {
  try {
    console.log("=== Tilko API 다중 지역 테스트 ===");
    const rsaPublicKey = await getPublicKey();
    console.log("공개키 OK");

    for (const loc of TEST_LOCATIONS) {
      await testLocation(loc.label, loc.lat, loc.lng, rsaPublicKey);
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log("전체 테스트 완료!");
  } catch (e) {
    console.error("Error:", e.message);
    console.error(e.stack);
  }
})();
