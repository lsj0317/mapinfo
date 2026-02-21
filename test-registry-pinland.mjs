// pin_land (18자리) 사용 테스트 - 단 1회 호출 (100원 비용)
import crypto from 'crypto';
import { readFileSync } from 'fs';

const envContent = readFileSync('.env', 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const [key, ...vals] = line.split('=');
  if (key && vals.length) env[key.trim()] = vals.join('=').trim();
});

const { TILKO_API_KEY, IROS_USER_ID, IROS_USER_PASSWORD, EMONEY_NO1, EMONEY_NO2, EMONEY_PWD } = env;
const apiHost = "https://api.tilko.net";

function aesEncrypt(key, iv, plainText) {
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  let ret = cipher.update(plainText, "utf8", "base64");
  ret += cipher.final("base64");
  return ret;
}

function rsaEncrypt(publicKeyBase64, aesKey) {
  const pem = "-----BEGIN PUBLIC KEY-----\n" + publicKeyBase64 + "\n-----END PUBLIC KEY-----";
  return crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, aesKey).toString("base64");
}

async function getPublicKey() {
  const res = await fetch(`${apiHost}/api/Auth/GetPublicKey?APIkey=${TILKO_API_KEY}`);
  return (await res.json()).PublicKey;
}

(async () => {
  console.log("=== pin_land (18자리) RealtyRegistry 테스트 (1회, ~100원) ===\n");

  // SmplSrchList에서 확인된 토지 pin_land
  // pin=13482009007109 (14자리) → pin_land=134820090071090001 (18자리)
  const PIN_LAND = "134820090071090001";
  const PIN_LAND_LABEL = "경기도 오산시 오산동 906 (토지)";

  console.log(`사용 pin_land: ${PIN_LAND} (${PIN_LAND.length}자리)`);
  console.log(`대상: ${PIN_LAND_LABEL}`);

  const pubKey = await getPublicKey();
  const aesKey = crypto.randomBytes(16);
  const aesIv = Buffer.alloc(16, 0);
  const encKey = rsaEncrypt(pubKey, aesKey);

  const body = {
    Auth: {
      UserId: aesEncrypt(aesKey, aesIv, IROS_USER_ID),
      UserPassword: aesEncrypt(aesKey, aesIv, IROS_USER_PASSWORD),
    },
    Pin: aesEncrypt(aesKey, aesIv, PIN_LAND),  // ← pin_land 18자리 사용
    EmoneyNo1: aesEncrypt(aesKey, aesIv, EMONEY_NO1),
    EmoneyNo2: aesEncrypt(aesKey, aesIv, EMONEY_NO2),
    EmoneyPwd: aesEncrypt(aesKey, aesIv, EMONEY_PWD),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150000);

  console.log("\n전송 중... (최대 150초 대기)\n");
  const startTime = Date.now();

  try {
    const res = await fetch(`${apiHost}/api/v2.0/Iros2IdLogin/RealtyRegistry`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "API-KEY": TILKO_API_KEY,
        "ENC-KEY": encKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const json = await res.json();

    console.log(`응답시간: ${elapsed}초 | HTTP: ${res.status}`);
    console.log(`Status: ${json.Status} | Message: ${json.Message}`);
    if (json.PointBalance !== undefined) console.log(`잔액: ${json.PointBalance}원`);
    if (json.ErrorCode) console.log(`ErrorCode: ${json.ErrorCode} | ErrorLog: ${json.ErrorLog}`);

    if (json.Message === 'OK' || json.Message === '성공') {
      const xml = json.XmlData || '';
      const ownerMatch = xml.match(/<owner_nm>([^<]*)<\/owner_nm>/);
      const addrMatch = xml.match(/<rd_addr>([^<]*)<\/rd_addr>/) || xml.match(/<jibun_addr>([^<]*)<\/jibun_addr>/);
      const areaMatch = xml.match(/<area>([^<]*)<\/area>/);
      const purposeMatch = xml.match(/<purpose_nm>([^<]*)<\/purpose_nm>/);
      console.log("\n✅ 등기부등본 조회 성공!");
      console.log("  소유주:", ownerMatch?.[1] || '없음');
      console.log("  주소:  ", addrMatch?.[1] || '없음');
      console.log("  면적:  ", areaMatch?.[1] ? areaMatch[1] + ' ㎡' : '없음');
      console.log("  용도:  ", purposeMatch?.[1] || '없음');
      console.log("\n→ 앞으로 pin_land(18자리) 필드를 사용해야 합니다!");
    } else {
      console.log("\n❌ 여전히 실패.");
      console.log("→ pin 형식 이외의 다른 원인일 수 있음. 틸코 고객센터 문의 필요.");
    }
  } catch (e) {
    clearTimeout(timer);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (e.name === 'AbortError') {
      console.log(`❌ ${elapsed}초 타임아웃`);
    } else {
      console.log(`❌ 오류: ${e.message}`);
    }
  }
})();
