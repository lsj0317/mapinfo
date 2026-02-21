// VWorld 데이터 품질 검증 + Tilko Registry 타임아웃 진단
// 공장/산업단지 위주로 테스트 (태양광 설치 영업 앱 용도)
import { readFileSync } from 'fs';

const envContent = readFileSync('.env', 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const [key, ...vals] = line.split('=');
  if (key && vals.length) env[key.trim()] = vals.join('=').trim();
});

const { VWORLD_API_KEY, TILKO_API_KEY } = env;

// 공장/산업단지 테스트 좌표 (지붕형 태양광 설치 대상)
const FACTORY_LOCATIONS = [
  { label: "경기 안산 반월공단", lat: 37.3213, lng: 126.8343 },
  { label: "인천 남동공단", lat: 37.4366, lng: 126.7337 },
  { label: "경기 시화산업단지", lat: 37.3167, lng: 126.7478 },
];

async function verifyVWorldData(label, lat, lng) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[검증] ${label}`);
  console.log(`좌표: lat=${lat}, lng=${lng}`);
  console.log('='.repeat(60));

  // 1. 지번주소(PARCEL) 조회 → PNU 포함
  console.log('\n[A] 지번주소 & PNU 조회 (VWorld Address API)');
  try {
    const parcelUrl = `https://api.vworld.kr/req/address?service=address&request=getAddress&version=2.0&crs=EPSG:4326&point=${lng},${lat}&type=PARCEL&format=json&key=${VWORLD_API_KEY}`;
    const parcelRes = await fetch(parcelUrl);
    const parcelJson = await parcelRes.json();

    if (parcelJson.response.status === 'OK' && parcelJson.response.result) {
      const r = parcelJson.response.result[0];
      const s = r.structure;
      // PNU = 법정동코드(10) + 대지구분(1) + 본번(4) + 부번(4)
      const level4LC = s.level4LC || '';
      const level5 = s.level5 || '0-0';
      const parts = level5.split('-');
      const bon = (parts[0] || '0').padStart(4, '0');
      const bu = (parts[1] || '0').padStart(4, '0');
      const pnu = `${level4LC}1${bon}${bu}`;

      console.log(`  지번주소: ${r.text}`);
      console.log(`  법정동코드(level4LC): ${level4LC}`);
      console.log(`  지번(level5): ${level5} → 본번:${bon} 부번:${bu}`);
      console.log(`  PNU (19자리): ${pnu} (길이:${pnu.length})`);
      console.log(`  PNU 유효성: ${pnu.length === 19 ? '✅ 정상' : '❌ 비정상 (19자리 아님)'}`);
    } else {
      console.log(`  ❌ 조회 실패: ${parcelJson.response.status}`);
    }
  } catch (e) {
    console.log(`  ❌ 오류: ${e.message}`);
  }

  // 2. 도로명주소(ROAD) 조회
  console.log('\n[B] 도로명주소 조회');
  try {
    const roadUrl = `https://api.vworld.kr/req/address?service=address&request=getAddress&version=2.0&crs=EPSG:4326&point=${lng},${lat}&type=ROAD&format=json&key=${VWORLD_API_KEY}`;
    const roadRes = await fetch(roadUrl);
    const roadJson = await roadRes.json();

    if (roadJson.response.status === 'OK' && roadJson.response.result) {
      const r = roadJson.response.result[0];
      console.log(`  도로명주소: ${r.text}`);
      console.log(`  시/도: ${r.structure.level1}`);
      console.log(`  시/군/구: ${r.structure.level2}`);
      console.log(`  도로명: ${r.structure.level6}`);
      console.log(`  건물번호: ${r.structure.level7}`);
    } else {
      console.log(`  ❌ 조회 실패: ${roadJson.response.status}`);
    }
  } catch (e) {
    console.log(`  ❌ 오류: ${e.message}`);
  }

  // 3. 장소(Place) 검색 - 실제 상호명 확인
  console.log('\n[C] 장소 검색 (실제 상호명 확인)');
  try {
    const RADIUS_DEGREE = 0.005; // 약 500m
    const minx = lng - RADIUS_DEGREE;
    const maxx = lng + RADIUS_DEGREE;
    const miny = lat - RADIUS_DEGREE;
    const maxy = lat + RADIUS_DEGREE;
    const bbox = `${minx},${miny},${maxx},${maxy}`;

    const placeUrl = `https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=5&page=1&query=공장&type=place&format=json&errorformat=json&bbox=${bbox}&key=${VWORLD_API_KEY}`;
    const placeRes = await fetch(placeUrl);
    const placeJson = await placeRes.json();

    if (placeJson.response.status === 'OK' && placeJson.response.result) {
      const items = placeJson.response.result.items;
      console.log(`  검색결과 ${items.length}건:`);
      items.forEach((item, i) => {
        console.log(`    [${i}] 상호: ${item.title}`);
        console.log(`         도로명: ${item.address.road || '없음'}`);
        console.log(`         지번: ${item.address.parcel || '없음'}`);
        console.log(`         분류: ${item.category || '없음'}`);
      });
    } else {
      console.log(`  결과없음(상태: ${placeJson.response.status})`);
      // "공장" 검색 없으면 "산업" 키워드 재시도
      const placeUrl2 = `https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=5&page=1&query=산업&type=place&format=json&errorformat=json&bbox=${bbox}&key=${VWORLD_API_KEY}`;
      const placeRes2 = await fetch(placeUrl2);
      const placeJson2 = await placeRes2.json();
      if (placeJson2.response.status === 'OK' && placeJson2.response.result) {
        const items2 = placeJson2.response.result.items;
        console.log(`  "산업" 키워드 검색 ${items2.length}건:`);
        items2.slice(0, 3).forEach((item, i) => {
          console.log(`    [${i}] ${item.title} | ${item.address.road || item.address.parcel}`);
        });
      }
    }
  } catch (e) {
    console.log(`  ❌ 오류: ${e.message}`);
  }

  // 4. 지적도 WFS 데이터로 필지 정보 확인
  console.log('\n[D] 지적도 WFS 필지 정보 (실제 지번 검증)');
  try {
    // VWorld WFS로 해당 좌표 필지 조회
    const wfsUrl = `https://api.vworld.kr/req/wfs?service=WFS&version=2.0.0&request=GetFeature&typename=lp_pa_cbnd_bubun&bbox=${lng-0.001},${lat-0.001},${lng+0.001},${lat+0.001},EPSG:4326&srsname=EPSG:4326&format=application/json&key=${VWORLD_API_KEY}&maxFeatures=3`;
    const wfsRes = await fetch(wfsUrl);
    const wfsText = await wfsRes.text();

    if (wfsText.startsWith('{')) {
      const wfsJson = JSON.parse(wfsText);
      if (wfsJson.features && wfsJson.features.length > 0) {
        console.log(`  WFS 필지 데이터 ${wfsJson.features.length}건:`);
        wfsJson.features.slice(0, 3).forEach((f, i) => {
          const p = f.properties;
          console.log(`    [${i}] PNU: ${p.pnu || p.PNU || '없음'} | 지번: ${p.jibun || p.JIBUN || '없음'} | 용도: ${p.land_use_nm || p.LAND_USE_NM || '없음'}`);
        });
      } else {
        console.log(`  WFS 결과 없음 (features: ${wfsJson.totalFeatures || 0})`);
      }
    } else {
      // XML 응답인 경우
      console.log(`  WFS XML 응답 (앞 300자): ${wfsText.substring(0, 300)}`);
    }
  } catch (e) {
    console.log(`  ❌ 오류: ${e.message}`);
  }
}

async function diagnoseTilkoRegistry() {
  console.log('\n' + '='.repeat(60));
  console.log('[Tilko RealtyRegistry 타임아웃 진단]');
  console.log('='.repeat(60));
  console.log('');
  console.log('단축 타임아웃(15초)으로 재시도 → 서버 응답 여부 확인');

  try {
    const crypto = await import('crypto');

    // 공개키 조회
    const pubKeyRes = await fetch(`https://api.tilko.net/api/Auth/GetPublicKey?APIkey=${TILKO_API_KEY}`);
    const pubKeyJson = await pubKeyRes.json();
    const pubKey = pubKeyJson.PublicKey;
    console.log('공개키 길이:', pubKey.length, '자');

    // AES 키 생성
    const aesKey = crypto.randomBytes(16);
    const aesIv = Buffer.alloc(16, 0);

    // AES 암호화
    const encryptAES = (text) => {
      const cipher = crypto.createCipheriv('aes-128-cbc', aesKey, aesIv);
      let ret = cipher.update(text, 'utf8', 'base64');
      ret += cipher.final('base64');
      return ret;
    };

    // RSA 암호화
    const pem = '-----BEGIN PUBLIC KEY-----\n' + pubKey + '\n-----END PUBLIC KEY-----';
    const encKey = crypto.publicEncrypt(
      { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
      aesKey
    ).toString('base64');

    const { IROS_USER_ID, IROS_USER_PASSWORD, EMONEY_NO1, EMONEY_NO2, EMONEY_PWD } = env;

    const body = {
      Auth: {
        UserId: encryptAES(IROS_USER_ID),
        UserPassword: encryptAES(IROS_USER_PASSWORD),
      },
      Pin: encryptAES('13482022003026'), // 이전 테스트에서 성공한 오산시 pin
      EmoneyNo1: encryptAES(EMONEY_NO1),
      EmoneyNo2: encryptAES(EMONEY_NO2),
      EmoneyPwd: encryptAES(EMONEY_PWD),
    };

    console.log('요청 전송 중...');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000); // 15초

    const startTime = Date.now();
    const regRes = await fetch('https://api.tilko.net/api/v2.0/Iros2IdLogin/RealtyRegistry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'API-KEY': TILKO_API_KEY,
        'ENC-KEY': encKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const elapsed = Date.now() - startTime;
    const regJson = await regRes.json();

    console.log(`응답시간: ${elapsed}ms`);
    console.log(`HTTP 상태: ${regRes.status}`);
    console.log(`Message: ${regJson.Message}`);
    console.log(`ErrorCode: ${regJson.ErrorCode || '없음'}`);
    console.log(`ErrorLog: ${regJson.ErrorLog || '없음'}`);
    console.log(`TargetMessage: ${regJson.TargetMessage || '없음'}`);
    if (regJson.PointBalance !== undefined) console.log(`포인트 잔액: ${regJson.PointBalance}원`);

    if (regJson.Message === 'OK' || regJson.Message === '성공') {
      console.log('✅ 등기부 조회 성공!');
      const xmlData = regJson.XmlData || '';
      const ownerMatch = xmlData.match(/<owner_nm>([^<]*)<\/owner_nm>/);
      console.log('소유주:', ownerMatch ? ownerMatch[1] : '없음');
    } else {
      console.log('❌ 조회 실패');
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      console.log('❌ 15초 타임아웃 - 서버가 응답하지 않음');
      console.log('원인 추정: 인터넷등기소(IROS) 인증 오류 또는 서버 과부하');
      console.log('');
      console.log('해결방법:');
      console.log('  1. IROS_USER_ID, IROS_USER_PASSWORD 유효성 확인');
      console.log('  2. EMONEY_NO1/NO2/PWD (전자결제 정보) 확인');
      console.log('  3. 틸코 대시보드에서 잔액/API 키 상태 확인');
    } else {
      console.log('❌ 오류:', e.message);
    }
  }
}

(async () => {
  console.log('=== VWorld 데이터 품질 검증 + Tilko 진단 ===\n');
  console.log('목적: 공장/건물 열람 앱을 위한 데이터 품질 확인');
  console.log('     (지붕형 태양광 영업 지원 앱)');

  // VWorld 데이터 검증 (공장 지역 3곳)
  for (const loc of FACTORY_LOCATIONS) {
    await verifyVWorldData(loc.label, loc.lat, loc.lng);
  }

  // Tilko Registry 타임아웃 진단
  await diagnoseTilkoRegistry();

  console.log('\n' + '='.repeat(60));
  console.log('검증 완료');
})();
