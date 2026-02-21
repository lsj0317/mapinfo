// Tilko RealtyRegistry 상세 진단 - 여러 pin 시도
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
  const json = await res.json();
  return json.PublicKey;
}

async function tryRegistry(pin, label) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`[시도] pin=${pin} | ${label}`);

  try {
    const pubKey = await getPublicKey();
    const aesKey = crypto.randomBytes(16);
    const aesIv = Buffer.alloc(16, 0);
    const encKey = rsaEncrypt(pubKey, aesKey);

    const body = {
      Auth: {
        UserId: aesEncrypt(aesKey, aesIv, IROS_USER_ID),
        UserPassword: aesEncrypt(aesKey, aesIv, IROS_USER_PASSWORD),
      },
      Pin: aesEncrypt(aesKey, aesIv, pin),
      EmoneyNo1: aesEncrypt(aesKey, aesIv, EMONEY_NO1),
      EmoneyNo2: aesEncrypt(aesKey, aesIv, EMONEY_NO2),
      EmoneyPwd: aesEncrypt(aesKey, aesIv, EMONEY_PWD),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150000); // 150초

    const startTime = Date.now();
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

    console.log(`응답시간: ${elapsed}초 | HTTP: ${res.status} | Status: ${json.Status} | Message: ${json.Message}`);
    if (json.PointBalance !== undefined) console.log(`잔액: ${json.PointBalance}원`);

    if (json.Status === 'Error' || json.ErrorCode) {
      console.log(`ErrorCode: ${json.ErrorCode} | ErrorLog: ${json.ErrorLog}`);
      return false;
    }

    if (json.Message === 'OK' || json.Message === '성공') {
      const xml = json.XmlData || '';
      const ownerMatch = xml.match(/<owner_nm>([^<]*)<\/owner_nm>/);
      const addrMatch = xml.match(/<rd_addr>([^<]*)<\/rd_addr>/) || xml.match(/<jibun_addr>([^<]*)<\/jibun_addr>/);
      const areaMatch = xml.match(/<area>([^<]*)<\/area>/);
      const purposeMatch = xml.match(/<purpose_nm>([^<]*)<\/purpose_nm>/);
      console.log("\n  ┌── 등기부등본 결과 ─────────────────────");
      console.log(`  │ 소유주: ${ownerMatch?.[1] || '없음'}`);
      console.log(`  │ 주소:   ${addrMatch?.[1] || '없음'}`);
      console.log(`  │ 면적:   ${areaMatch?.[1] || '없음'} ㎡`);
      console.log(`  │ 용도:   ${purposeMatch?.[1] || '없음'}`);
      console.log("  └─────────────────────────────────────────");
      return true;
    }
    return false;
  } catch (e) {
    if (e.name === 'AbortError') {
      console.log(`❌ 150초 타임아웃`);
    } else {
      console.log(`❌ 오류: ${e.message}`);
    }
    return false;
  }
}

(async () => {
  console.log("=== Tilko RealtyRegistry pin 유효성 검증 ===");
  console.log("잔액 확인됨(7820원), 자격증명 정상 → pin 문제 진단\n");

  // 이전 RetrieveSmplSrchList에서 오산시에서 반환된 pin들 시도
  const testCases = [
    { pin: "13482009007109", label: "토지 / 경기도 오산시 오산동 906" },
    { pin: "13482006009451", label: "집합건물 / 경기도 오산시 오산동 865-1" },
    { pin: "13482023004003", label: "집합건물 / 경기도 오산시 오산동 880-8" },
  ];

  for (const tc of testCases) {
    const ok = await tryRegistry(tc.pin, tc.label);
    if (ok) {
      console.log("\n✅ 성공! 이 pin 형식이 올바른 것을 확인.");
      break;
    }
    // 연속 요청 간 잠깐 대기
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log("\n=== 진단 완료 ===");
})();
