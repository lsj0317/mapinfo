// 서울 VWorld 역지오코딩 → SmplSrchList → (선택) RealtyRegistry
import crypto from 'crypto';
import { readFileSync } from 'fs';

const envContent = readFileSync('.env', 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const [key, ...vals] = line.split('=');
  if (key && vals.length) env[key.trim()] = vals.join('=').trim();
});

const { VWORLD_API_KEY, TILKO_API_KEY } = env;
const apiHost = "https://api.tilko.net";

async function getPublicKey() {
  const res = await fetch(`${apiHost}/api/Auth/GetPublicKey?APIkey=${TILKO_API_KEY}`);
  return (await res.json()).PublicKey;
}
function rsaEncrypt(pubKeyB64, aesKey) {
  const pem = "-----BEGIN PUBLIC KEY-----\n" + pubKeyB64 + "\n-----END PUBLIC KEY-----";
  return crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, aesKey).toString("base64");
}

// 서울 지역 테스트 좌표 (안정적인 주거/상업지역)
const TEST_COORDS = [
  { label: "서울 강남 역삼동 (주거)", lat: 37.5010, lng: 127.0369 },
  { label: "서울 마포 공덕동 (상업)", lat: 37.5443, lng: 126.9510 },
  { label: "서울 송파 잠실동 (집합건물)", lat: 37.5126, lng: 127.1007 },
];

(async () => {
  const pubKey = await getPublicKey();
  const aesKey = crypto.randomBytes(16);
  const encKey = rsaEncrypt(pubKey, aesKey);

  for (const { label, lat, lng } of TEST_COORDS) {
    console.log(`\n${'='.repeat(55)}`);
    console.log(`[${label}] lat=${lat}, lng=${lng}`);

    // 1. VWorld 지번주소 조회
    const vwUrl = `https://api.vworld.kr/req/address?service=address&request=getAddress&version=2.0&crs=EPSG:4326&point=${lng},${lat}&type=PARCEL&format=json&key=${VWORLD_API_KEY}`;
    const vwRes = await fetch(vwUrl);
    const vwJson = await vwRes.json();

    if (vwJson.response.status !== 'OK' || !vwJson.response.result) {
      console.log("VWorld 주소 조회 실패:", vwJson.response.status);
      continue;
    }
    const jibunAddr = vwJson.response.result[0].text;
    console.log("VWorld 지번주소:", jibunAddr);

    // 2. SmplSrchList (무료)
    const srchRes = await fetch(`${apiHost}/api/v2.0/Iros2/RetrieveSmplSrchList`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "API-KEY": TILKO_API_KEY, "ENC-KEY": encKey },
      body: JSON.stringify({ Address: jibunAddr }),
    });
    const srchJson = await srchRes.json();
    console.log(`SmplSrchList: ${srchJson.Message} | ${(srchJson.DataList||[]).length}건`);

    const list = srchJson.DataList || [];
    if (list.length === 0) {
      // 시/도 제거 후 재시도
      const shortAddr = jibunAddr.replace(/^서울특별시\s*/, '서울 ');
      console.log(`재시도 주소: ${shortAddr}`);
      const retryRes = await fetch(`${apiHost}/api/v2.0/Iros2/RetrieveSmplSrchList`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "API-KEY": TILKO_API_KEY, "ENC-KEY": encKey },
        body: JSON.stringify({ Address: shortAddr }),
      });
      const retryJson = await retryRes.json();
      console.log(`재시도 결과: ${retryJson.Message} | ${(retryJson.DataList||[]).length}건`);
      const list2 = retryJson.DataList || [];
      list2.slice(0, 2).forEach((item, i) => {
        console.log(`  [${i}] ${item.real_cls_cd} | pin=${item.pin} | spe=${item.pin_mid_spe_yn} | ${item.real_indi_cont}`);
      });
      continue;
    }

    list.slice(0, 3).forEach((item, i) => {
      const mark = item.pin_mid_spe_yn === 'N' ? '★' : ' ';
      console.log(`  ${mark}[${i}] ${item.real_cls_cd} | pin=${item.pin} | spe=${item.pin_mid_spe_yn} | ${item.real_indi_cont}`);
    });

    // 추천 pin 출력
    const good = list.filter(i => i.pin_mid_spe_yn !== 'Y');
    const best = good.find(i => i.real_cls_cd === '집합건물') || good.find(i => i.real_cls_cd === '건물') || good[0];
    if (best) {
      console.log(`\n  → RealtyRegistry 추천 pin: ${best.pin} (${best.real_cls_cd} / ${best.real_indi_cont})`);
    }
  }

  console.log("\n=== 완료 (유료 호출 없음) ===");
})();
