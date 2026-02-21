// 서울 주요 지역 SmplSrchList 무료 확인 + 최적 pin 선별
import crypto from 'crypto';
import { readFileSync } from 'fs';

const envContent = readFileSync('.env', 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const [key, ...vals] = line.split('=');
  if (key && vals.length) env[key.trim()] = vals.join('=').trim();
});

const { TILKO_API_KEY } = env;
const apiHost = "https://api.tilko.net";

async function getPublicKey() {
  const res = await fetch(`${apiHost}/api/Auth/GetPublicKey?APIkey=${TILKO_API_KEY}`);
  return (await res.json()).PublicKey;
}
function rsaEncrypt(pubKeyB64, aesKey) {
  const pem = "-----BEGIN PUBLIC KEY-----\n" + pubKeyB64 + "\n-----END PUBLIC KEY-----";
  return crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, aesKey).toString("base64");
}

async function smplSearch(addr, encKey) {
  const res = await fetch(`${apiHost}/api/v2.0/Iros2/RetrieveSmplSrchList`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "API-KEY": TILKO_API_KEY, "ENC-KEY": encKey },
    body: JSON.stringify({ Address: addr }),
  });
  const json = await res.json();
  return { status: res.status, message: json.Message, list: json.DataList || [] };
}

(async () => {
  const pubKey = await getPublicKey();
  const aesKey = crypto.randomBytes(16);
  const encKey = rsaEncrypt(pubKey, aesKey);

  // 서울 주요 지역 주소 목록 (건물/집합건물이 많은 안정적인 지역)
  const addresses = [
    "서울특별시 강남구 테헤란로 152",   // 강남파이낸스센터 도로명
    "서울특별시 강남구 역삼동 832",      // 역삼동 지번
    "서울특별시 마포구 상암동 1652",     // 상암 디지털미디어시티
    "서울특별시 송파구 신천동 7",        // 잠실 롯데월드타워
  ];

  for (const addr of addresses) {
    console.log(`\n주소: ${addr}`);
    const { status, message, list } = await smplSearch(addr, encKey);
    console.log(`HTTP ${status} | ${message} | ${list.length}건`);

    if (list.length === 0) {
      console.log("  → 결과 없음");
      continue;
    }

    // 집합건물 또는 건물 우선, 특수필지 제외
    const good = list.filter(i => i.pin_mid_spe_yn !== 'Y');
    const best = good.find(i => i.real_cls_cd === '집합건물')
               || good.find(i => i.real_cls_cd === '건물')
               || good[0];

    list.slice(0, 3).forEach((item, i) => {
      const mark = item === best ? '★' : ' ';
      console.log(`  ${mark}[${i}] ${item.real_cls_cd} | pin=${item.pin} | use=${item.use_cls_cd} | spe=${item.pin_mid_spe_yn} | ${item.real_indi_cont}`);
    });

    if (best) {
      console.log(`\n  → RealtyRegistry 추천 pin: ${best.pin} (${best.real_cls_cd})`);
      console.log(`    (이 pin으로 유료 테스트하면 정상 작동 여부 확인 가능)`);
    }
  }

  console.log("\n=== SmplSrchList 무료 확인 완료 ===");
  console.log("RealtyRegistry 유료 테스트 진행 여부를 결정해 주세요.");
})();
