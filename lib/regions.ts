// 전국 지역 계층 데이터
// 구조: 도(Province) → 시군구(City) → 읍면동(Town)

export interface TownData {
    name: string;
    latitude: number;
    longitude: number;
}

export interface CityData {
    name: string;
    latitude: number;
    longitude: number;
    towns: TownData[];
}

export interface ProvinceData {
    name: string;
    short: string;        // 약칭 (버튼 표시용)
    latitude: number;
    longitude: number;
    cities: CityData[];
}

export const REGIONS: ProvinceData[] = [
    // ===== 서울특별시 =====
    {
        name: '서울특별시',
        short: '서울',
        latitude: 37.5665,
        longitude: 126.9780,
        cities: [
            { name: '강남구', latitude: 37.5172, longitude: 127.0473, towns: [{ name: '역삼동', latitude: 37.5006, longitude: 127.0369 }, { name: '삼성동', latitude: 37.5140, longitude: 127.0567 }, { name: '개포동', latitude: 37.4845, longitude: 127.0537 }, { name: '논현동', latitude: 37.5116, longitude: 127.0278 }] },
            { name: '강동구', latitude: 37.5301, longitude: 127.1238, towns: [{ name: '천호동', latitude: 37.5388, longitude: 127.1241 }, { name: '길동', latitude: 37.5383, longitude: 127.1460 }, { name: '명일동', latitude: 37.5481, longitude: 127.1519 }] },
            { name: '강북구', latitude: 37.6396, longitude: 127.0253, towns: [{ name: '수유동', latitude: 37.6422, longitude: 127.0220 }, { name: '미아동', latitude: 37.6306, longitude: 127.0289 }] },
            { name: '강서구', latitude: 37.5509, longitude: 126.8497, towns: [{ name: '화곡동', latitude: 37.5477, longitude: 126.8498 }, { name: '등촌동', latitude: 37.5524, longitude: 126.8617 }, { name: '발산동', latitude: 37.5603, longitude: 126.8349 }] },
            { name: '관악구', latitude: 37.4784, longitude: 126.9516, towns: [{ name: '신림동', latitude: 37.4831, longitude: 126.9293 }, { name: '봉천동', latitude: 37.4892, longitude: 126.9456 }] },
            { name: '광진구', latitude: 37.5385, longitude: 127.0823, towns: [{ name: '중곡동', latitude: 37.5512, longitude: 127.0823 }, { name: '구의동', latitude: 37.5372, longitude: 127.0834 }, { name: '자양동', latitude: 37.5369, longitude: 127.0711 }] },
            { name: '구로구', latitude: 37.4954, longitude: 126.8874, towns: [{ name: '구로동', latitude: 37.4955, longitude: 126.8877 }, { name: '오류동', latitude: 37.4986, longitude: 126.8667 }, { name: '개봉동', latitude: 37.4956, longitude: 126.8560 }] },
            { name: '금천구', latitude: 37.4569, longitude: 126.8955, towns: [{ name: '시흥동', latitude: 37.4579, longitude: 126.8967 }, { name: '독산동', latitude: 37.4666, longitude: 126.9018 }] },
            { name: '노원구', latitude: 37.6542, longitude: 127.0568, towns: [{ name: '상계동', latitude: 37.6594, longitude: 127.0643 }, { name: '중계동', latitude: 37.6474, longitude: 127.0739 }, { name: '공릉동', latitude: 37.6255, longitude: 127.0785 }] },
            { name: '도봉구', latitude: 37.6688, longitude: 127.0471, towns: [{ name: '쌍문동', latitude: 37.6617, longitude: 127.0319 }, { name: '방학동', latitude: 37.6726, longitude: 127.0291 }, { name: '창동', latitude: 37.6531, longitude: 127.0476 }] },
            { name: '동대문구', latitude: 37.5744, longitude: 127.0396, towns: [{ name: '제기동', latitude: 37.5822, longitude: 127.0356 }, { name: '전농동', latitude: 37.5797, longitude: 127.0557 }, { name: '이문동', latitude: 37.5893, longitude: 127.0593 }] },
            { name: '동작구', latitude: 37.5124, longitude: 126.9393, towns: [{ name: '노량진동', latitude: 37.5133, longitude: 126.9428 }, { name: '사당동', latitude: 37.4858, longitude: 126.9811 }, { name: '상도동', latitude: 37.5028, longitude: 126.9518 }] },
            { name: '마포구', latitude: 37.5638, longitude: 126.9084, towns: [{ name: '합정동', latitude: 37.5497, longitude: 126.9104 }, { name: '상암동', latitude: 37.5830, longitude: 126.8990 }, { name: '공덕동', latitude: 37.5446, longitude: 126.9514 }] },
            { name: '서대문구', latitude: 37.5791, longitude: 126.9368, towns: [{ name: '홍제동', latitude: 37.5894, longitude: 126.9417 }, { name: '신촌동', latitude: 37.5557, longitude: 126.9366 }, { name: '남가좌동', latitude: 37.5760, longitude: 126.9194 }] },
            { name: '서초구', latitude: 37.4837, longitude: 127.0324, towns: [{ name: '서초동', latitude: 37.4923, longitude: 127.0292 }, { name: '방배동', latitude: 37.4814, longitude: 126.9975 }, { name: '반포동', latitude: 37.5059, longitude: 127.0085 }] },
            { name: '성동구', latitude: 37.5633, longitude: 127.0369, towns: [{ name: '성수동', latitude: 37.5444, longitude: 127.0557 }, { name: '왕십리동', latitude: 37.5619, longitude: 127.0424 }, { name: '금호동', latitude: 37.5536, longitude: 127.0199 }] },
            { name: '성북구', latitude: 37.5894, longitude: 127.0167, towns: [{ name: '석관동', latitude: 37.6024, longitude: 127.0601 }, { name: '길음동', latitude: 37.6031, longitude: 127.0220 }, { name: '정릉동', latitude: 37.6119, longitude: 127.0023 }] },
            { name: '송파구', latitude: 37.5145, longitude: 127.1059, towns: [{ name: '잠실동', latitude: 37.5131, longitude: 127.0965 }, { name: '문정동', latitude: 37.4832, longitude: 127.1239 }, { name: '거여동', latitude: 37.4949, longitude: 127.1414 }] },
            { name: '양천구', latitude: 37.5270, longitude: 126.8561, towns: [{ name: '목동', latitude: 37.5274, longitude: 126.8745 }, { name: '신정동', latitude: 37.5276, longitude: 126.8561 }] },
            { name: '영등포구', latitude: 37.5264, longitude: 126.8962, towns: [{ name: '여의도동', latitude: 37.5219, longitude: 126.9245 }, { name: '영등포동', latitude: 37.5259, longitude: 126.9063 }, { name: '양평동', latitude: 37.5255, longitude: 126.8783 }] },
            { name: '용산구', latitude: 37.5311, longitude: 126.9810, towns: [{ name: '이태원동', latitude: 37.5349, longitude: 126.9935 }, { name: '한남동', latitude: 37.5377, longitude: 127.0023 }, { name: '서빙고동', latitude: 37.5195, longitude: 127.0024 }] },
            { name: '은평구', latitude: 37.6176, longitude: 126.9227, towns: [{ name: '불광동', latitude: 37.6101, longitude: 126.9279 }, { name: '응암동', latitude: 37.5938, longitude: 126.9189 }, { name: '진관동', latitude: 37.6452, longitude: 126.9088 }] },
            { name: '종로구', latitude: 37.5735, longitude: 126.9788, towns: [{ name: '종로동', latitude: 37.5720, longitude: 126.9793 }, { name: '혜화동', latitude: 37.5826, longitude: 127.0019 }, { name: '청운동', latitude: 37.5927, longitude: 126.9685 }] },
            { name: '중구', latitude: 37.5641, longitude: 126.9979, towns: [{ name: '명동', latitude: 37.5636, longitude: 126.9832 }, { name: '을지로동', latitude: 37.5662, longitude: 126.9997 }, { name: '신당동', latitude: 37.5636, longitude: 127.0153 }] },
            { name: '중랑구', latitude: 37.6063, longitude: 127.0927, towns: [{ name: '면목동', latitude: 37.5847, longitude: 127.0856 }, { name: '신내동', latitude: 37.6180, longitude: 127.1012 }, { name: '망우동', latitude: 37.6034, longitude: 127.1106 }] },
        ],
    },

    // ===== 부산광역시 =====
    {
        name: '부산광역시',
        short: '부산',
        latitude: 35.1796,
        longitude: 129.0756,
        cities: [
            { name: '강서구', latitude: 35.2120, longitude: 128.9808, towns: [{ name: '명지동', latitude: 35.1005, longitude: 128.9453 }, { name: '가락동', latitude: 35.2337, longitude: 128.9632 }, { name: '녹산동', latitude: 35.1587, longitude: 128.9148 }] },
            { name: '금정구', latitude: 35.2428, longitude: 129.0921, towns: [{ name: '구서동', latitude: 35.2398, longitude: 129.0817 }, { name: '금정동', latitude: 35.2651, longitude: 129.0938 }, { name: '서동', latitude: 35.2289, longitude: 129.0875 }] },
            { name: '기장군', latitude: 35.2445, longitude: 129.2224, towns: [{ name: '기장읍', latitude: 35.2445, longitude: 129.2224 }, { name: '정관읍', latitude: 35.3009, longitude: 129.1693 }, { name: '장안읍', latitude: 35.3501, longitude: 129.2204 }, { name: '일광읍', latitude: 35.2804, longitude: 129.2328 }] },
            { name: '남구', latitude: 35.1364, longitude: 129.0836, towns: [{ name: '대연동', latitude: 35.1404, longitude: 129.0757 }, { name: '용호동', latitude: 35.1244, longitude: 129.1052 }, { name: '문현동', latitude: 35.1487, longitude: 129.0553 }] },
            { name: '동구', latitude: 35.1347, longitude: 129.0445, towns: [{ name: '초량동', latitude: 35.1327, longitude: 129.0436 }, { name: '수정동', latitude: 35.1286, longitude: 129.0528 }, { name: '범일동', latitude: 35.1419, longitude: 129.0578 }] },
            { name: '동래구', latitude: 35.1993, longitude: 129.0853, towns: [{ name: '온천동', latitude: 35.1993, longitude: 129.0795 }, { name: '명륜동', latitude: 35.2059, longitude: 129.0781 }, { name: '수안동', latitude: 35.1965, longitude: 129.0851 }] },
            { name: '부산진구', latitude: 35.1628, longitude: 129.0536, towns: [{ name: '부전동', latitude: 35.1618, longitude: 129.0536 }, { name: '전포동', latitude: 35.1533, longitude: 129.0596 }, { name: '개금동', latitude: 35.1513, longitude: 129.0124 }] },
            { name: '북구', latitude: 35.1973, longitude: 128.9906, towns: [{ name: '구포동', latitude: 35.1973, longitude: 128.9906 }, { name: '화명동', latitude: 35.2178, longitude: 129.0186 }, { name: '덕천동', latitude: 35.2043, longitude: 129.0076 }] },
            { name: '사상구', latitude: 35.1521, longitude: 128.9941, towns: [{ name: '괘법동', latitude: 35.1544, longitude: 128.9934 }, { name: '주례동', latitude: 35.1617, longitude: 128.9813 }, { name: '덕포동', latitude: 35.1571, longitude: 128.9698 }] },
            { name: '사하구', latitude: 35.1005, longitude: 128.9741, towns: [{ name: '당리동', latitude: 35.1003, longitude: 128.9742 }, { name: '다대동', latitude: 35.0624, longitude: 128.9694 }, { name: '신평동', latitude: 35.1138, longitude: 128.9627 }] },
            { name: '서구', latitude: 35.0981, longitude: 129.0259, towns: [{ name: '암남동', latitude: 35.0767, longitude: 129.0128 }, { name: '충무동', latitude: 35.0994, longitude: 129.0241 }] },
            { name: '수영구', latitude: 35.1456, longitude: 129.1133, towns: [{ name: '수영동', latitude: 35.1456, longitude: 129.1133 }, { name: '광안동', latitude: 35.1535, longitude: 129.1187 }, { name: '민락동', latitude: 35.1468, longitude: 129.1289 }] },
            { name: '연제구', latitude: 35.1769, longitude: 129.0808, towns: [{ name: '연산동', latitude: 35.1769, longitude: 129.0808 }, { name: '거제동', latitude: 35.1720, longitude: 129.0897 }] },
            { name: '영도구', latitude: 35.0893, longitude: 129.0685, towns: [{ name: '봉래동', latitude: 35.0893, longitude: 129.0685 }, { name: '동삼동', latitude: 35.0701, longitude: 129.0723 }] },
            { name: '중구', latitude: 35.1032, longitude: 129.0350, towns: [{ name: '중앙동', latitude: 35.1032, longitude: 129.0350 }, { name: '남포동', latitude: 35.0981, longitude: 129.0315 }] },
            { name: '해운대구', latitude: 35.1628, longitude: 129.1635, towns: [{ name: '해운대동', latitude: 35.1588, longitude: 129.1601 }, { name: '재송동', latitude: 35.1968, longitude: 129.1093 }, { name: '좌동', latitude: 35.1753, longitude: 129.1854 }, { name: '우동', latitude: 35.1657, longitude: 129.1808 }] },
        ],
    },

    // ===== 대구광역시 =====
    {
        name: '대구광역시',
        short: '대구',
        latitude: 35.8714,
        longitude: 128.6014,
        cities: [
            { name: '남구', latitude: 35.8455, longitude: 128.5971, towns: [{ name: '대명동', latitude: 35.8455, longitude: 128.5971 }, { name: '봉덕동', latitude: 35.8513, longitude: 128.6024 }] },
            { name: '달서구', latitude: 35.8296, longitude: 128.5326, towns: [{ name: '월성동', latitude: 35.8296, longitude: 128.5326 }, { name: '상인동', latitude: 35.8041, longitude: 128.5438 }, { name: '성당동', latitude: 35.8465, longitude: 128.5577 }] },
            { name: '달성군', latitude: 35.7751, longitude: 128.4313, towns: [{ name: '현풍읍', latitude: 35.6491, longitude: 128.4271 }, { name: '유가읍', latitude: 35.7135, longitude: 128.4582 }, { name: '화원읍', latitude: 35.8098, longitude: 128.4918 }, { name: '논공읍', latitude: 35.7641, longitude: 128.4619 }, { name: '옥포읍', latitude: 35.8188, longitude: 128.4590 }, { name: '하빈면', latitude: 35.8636, longitude: 128.3871 }, { name: '구지면', latitude: 35.6698, longitude: 128.4219 }] },
            { name: '동구', latitude: 35.8868, longitude: 128.6357, towns: [{ name: '신천동', latitude: 35.8721, longitude: 128.6288 }, { name: '안심동', latitude: 35.9013, longitude: 128.7050 }, { name: '방촌동', latitude: 35.8956, longitude: 128.6692 }] },
            { name: '북구', latitude: 35.8849, longitude: 128.5828, towns: [{ name: '산격동', latitude: 35.8858, longitude: 128.5943 }, { name: '검단동', latitude: 35.9258, longitude: 128.5721 }, { name: '칠성동', latitude: 35.8766, longitude: 128.5996 }, { name: '구암동', latitude: 35.9126, longitude: 128.5652 }] },
            { name: '서구', latitude: 35.8718, longitude: 128.5592, towns: [{ name: '내당동', latitude: 35.8718, longitude: 128.5592 }, { name: '비산동', latitude: 35.8843, longitude: 128.5532 }, { name: '평리동', latitude: 35.8696, longitude: 128.5399 }] },
            { name: '수성구', latitude: 35.8587, longitude: 128.6306, towns: [{ name: '만촌동', latitude: 35.8587, longitude: 128.6306 }, { name: '범어동', latitude: 35.8467, longitude: 128.6130 }, { name: '지산동', latitude: 35.8349, longitude: 128.6446 }] },
            { name: '중구', latitude: 35.8691, longitude: 128.6060, towns: [{ name: '동인동', latitude: 35.8691, longitude: 128.6060 }, { name: '수창동', latitude: 35.8756, longitude: 128.5972 }, { name: '남산동', latitude: 35.8593, longitude: 128.5992 }] },
        ],
    },

    // ===== 인천광역시 =====
    {
        name: '인천광역시',
        short: '인천',
        latitude: 37.4563,
        longitude: 126.7052,
        cities: [
            { name: '강화군', latitude: 37.7479, longitude: 126.4878, towns: [{ name: '강화읍', latitude: 37.7479, longitude: 126.4878 }, { name: '불은면', latitude: 37.7133, longitude: 126.5228 }, { name: '길상면', latitude: 37.6887, longitude: 126.5008 }] },
            { name: '계양구', latitude: 37.5371, longitude: 126.7379, towns: [{ name: '계산동', latitude: 37.5371, longitude: 126.7379 }, { name: '작전동', latitude: 37.5255, longitude: 126.7296 }] },
            { name: '남동구', latitude: 37.4489, longitude: 126.7319, towns: [{ name: '구월동', latitude: 37.4489, longitude: 126.7319 }, { name: '논현동', latitude: 37.4104, longitude: 126.7367 }, { name: '만수동', latitude: 37.4677, longitude: 126.7312 }] },
            { name: '동구', latitude: 37.4740, longitude: 126.6434, towns: [{ name: '만석동', latitude: 37.4740, longitude: 126.6434 }, { name: '창영동', latitude: 37.4729, longitude: 126.6509 }] },
            { name: '미추홀구', latitude: 37.4537, longitude: 126.6579, towns: [{ name: '주안동', latitude: 37.4537, longitude: 126.6579 }, { name: '용현동', latitude: 37.4453, longitude: 126.6786 }, { name: '학익동', latitude: 37.4415, longitude: 126.6594 }] },
            { name: '부평구', latitude: 37.5075, longitude: 126.7219, towns: [{ name: '부평동', latitude: 37.5075, longitude: 126.7219 }, { name: '삼산동', latitude: 37.5008, longitude: 126.7454 }, { name: '십정동', latitude: 37.5004, longitude: 126.7319 }] },
            { name: '서구', latitude: 37.5440, longitude: 126.6699, towns: [{ name: '청라동', latitude: 37.5440, longitude: 126.6699 }, { name: '검단동', latitude: 37.5975, longitude: 126.6801 }, { name: '가좌동', latitude: 37.5232, longitude: 126.6788 }] },
            { name: '연수구', latitude: 37.4104, longitude: 126.6780, towns: [{ name: '송도동', latitude: 37.3892, longitude: 126.6533 }, { name: '연수동', latitude: 37.4104, longitude: 126.6780 }, { name: '청학동', latitude: 37.4265, longitude: 126.6769 }] },
            { name: '옹진군', latitude: 37.4468, longitude: 126.6369, towns: [{ name: '북도면', latitude: 37.6289, longitude: 126.5131 }, { name: '자월면', latitude: 37.3064, longitude: 126.3146 }, { name: '덕적면', latitude: 37.2344, longitude: 126.1349 }] },
            { name: '중구', latitude: 37.4736, longitude: 126.6213, towns: [{ name: '신흥동', latitude: 37.4736, longitude: 126.6213 }, { name: '항동', latitude: 37.4780, longitude: 126.6200 }, { name: '영종동', latitude: 37.5004, longitude: 126.4798 }] },
        ],
    },

    // ===== 광주광역시 =====
    {
        name: '광주광역시',
        short: '광주',
        latitude: 35.1595,
        longitude: 126.8526,
        cities: [
            { name: '광산구', latitude: 35.1444, longitude: 126.7937, towns: [{ name: '운남동', latitude: 35.1444, longitude: 126.7937 }, { name: '수완동', latitude: 35.1765, longitude: 126.8013 }, { name: '첨단동', latitude: 35.2218, longitude: 126.8421 }] },
            { name: '남구', latitude: 35.1327, longitude: 126.9019, towns: [{ name: '봉선동', latitude: 35.1327, longitude: 126.9019 }, { name: '주월동', latitude: 35.1249, longitude: 126.8965 }, { name: '진월동', latitude: 35.1126, longitude: 126.8963 }] },
            { name: '동구', latitude: 35.1461, longitude: 126.9231, towns: [{ name: '충장로', latitude: 35.1461, longitude: 126.9231 }, { name: '지산동', latitude: 35.1329, longitude: 126.9306 }, { name: '계림동', latitude: 35.1511, longitude: 126.9175 }] },
            { name: '북구', latitude: 35.1742, longitude: 126.9121, towns: [{ name: '운암동', latitude: 35.1742, longitude: 126.9121 }, { name: '용봉동', latitude: 35.1744, longitude: 126.9078 }, { name: '일곡동', latitude: 35.2001, longitude: 126.9174 }] },
            { name: '서구', latitude: 35.1514, longitude: 126.8906, towns: [{ name: '상무동', latitude: 35.1514, longitude: 126.8906 }, { name: '치평동', latitude: 35.1552, longitude: 126.8795 }, { name: '화정동', latitude: 35.1383, longitude: 126.8869 }] },
        ],
    },

    // ===== 대전광역시 =====
    {
        name: '대전광역시',
        short: '대전',
        latitude: 36.3504,
        longitude: 127.3845,
        cities: [
            { name: '대덕구', latitude: 36.3465, longitude: 127.4151, towns: [{ name: '오정동', latitude: 36.3465, longitude: 127.4151 }, { name: '신탄진동', latitude: 36.4448, longitude: 127.3970 }] },
            { name: '동구', latitude: 36.3121, longitude: 127.4541, towns: [{ name: '용전동', latitude: 36.3121, longitude: 127.4541 }, { name: '판암동', latitude: 36.2988, longitude: 127.4527 }, { name: '대성동', latitude: 36.3354, longitude: 127.4312 }] },
            { name: '서구', latitude: 36.3553, longitude: 127.3836, towns: [{ name: '둔산동', latitude: 36.3553, longitude: 127.3836 }, { name: '월평동', latitude: 36.3677, longitude: 127.3678 }, { name: '탄방동', latitude: 36.3451, longitude: 127.3746 }] },
            { name: '유성구', latitude: 36.3624, longitude: 127.3566, towns: [{ name: '도안동', latitude: 36.3624, longitude: 127.3566 }, { name: '봉명동', latitude: 36.3589, longitude: 127.3411 }, { name: '구암동', latitude: 36.3737, longitude: 127.3279 }] },
            { name: '중구', latitude: 36.3252, longitude: 127.4213, towns: [{ name: '은행동', latitude: 36.3252, longitude: 127.4213 }, { name: '대흥동', latitude: 36.3290, longitude: 127.4246 }, { name: '목동', latitude: 36.3356, longitude: 127.4044 }] },
        ],
    },

    // ===== 울산광역시 =====
    {
        name: '울산광역시',
        short: '울산',
        latitude: 35.5384,
        longitude: 129.3114,
        cities: [
            { name: '남구', latitude: 35.5188, longitude: 129.3326, towns: [{ name: '삼산동', latitude: 35.5188, longitude: 129.3326 }, { name: '달동', latitude: 35.5273, longitude: 129.3218 }, { name: '무거동', latitude: 35.5007, longitude: 129.3183 }] },
            { name: '동구', latitude: 35.5051, longitude: 129.4163, towns: [{ name: '서부동', latitude: 35.5051, longitude: 129.4163 }, { name: '방어동', latitude: 35.4921, longitude: 129.4341 }] },
            { name: '북구', latitude: 35.5822, longitude: 129.3614, towns: [{ name: '농소동', latitude: 35.5822, longitude: 129.3614 }, { name: '매곡동', latitude: 35.5714, longitude: 129.3312 }, { name: '화봉동', latitude: 35.5602, longitude: 129.3492 }] },
            { name: '울주군', latitude: 35.5219, longitude: 129.2388, towns: [{ name: '언양읍', latitude: 35.5637, longitude: 129.0826 }, { name: '온양읍', latitude: 35.4228, longitude: 129.2848 }, { name: '범서읍', latitude: 35.5371, longitude: 129.2630 }, { name: '청량읍', latitude: 35.5032, longitude: 129.2993 }, { name: '웅촌면', latitude: 35.4795, longitude: 129.2139 }, { name: '삼남읍', latitude: 35.4848, longitude: 129.1476 }] },
            { name: '중구', latitude: 35.5663, longitude: 129.3320, towns: [{ name: '성남동', latitude: 35.5663, longitude: 129.3320 }, { name: '복산동', latitude: 35.5623, longitude: 129.3294 }, { name: '우정동', latitude: 35.5699, longitude: 129.3196 }] },
        ],
    },

    // ===== 세종특별자치시 =====
    {
        name: '세종특별자치시',
        short: '세종',
        latitude: 36.4800,
        longitude: 127.2890,
        cities: [
            { name: '조치원읍', latitude: 36.6011, longitude: 127.2985, towns: [{ name: '조치원읍', latitude: 36.6011, longitude: 127.2985 }] },
            { name: '연기면', latitude: 36.5263, longitude: 127.3041, towns: [{ name: '연기면', latitude: 36.5263, longitude: 127.3041 }] },
            { name: '연동면', latitude: 36.5651, longitude: 127.2694, towns: [{ name: '연동면', latitude: 36.5651, longitude: 127.2694 }] },
            { name: '부강면', latitude: 36.5313, longitude: 127.3541, towns: [{ name: '부강면', latitude: 36.5313, longitude: 127.3541 }] },
            { name: '금남면', latitude: 36.4839, longitude: 127.3254, towns: [{ name: '금남면', latitude: 36.4839, longitude: 127.3254 }] },
            { name: '장군면', latitude: 36.4648, longitude: 127.2645, towns: [{ name: '장군면', latitude: 36.4648, longitude: 127.2645 }] },
            { name: '연서면', latitude: 36.5942, longitude: 127.2398, towns: [{ name: '연서면', latitude: 36.5942, longitude: 127.2398 }] },
            { name: '전의면', latitude: 36.6508, longitude: 127.2155, towns: [{ name: '전의면', latitude: 36.6508, longitude: 127.2155 }] },
            { name: '전동면', latitude: 36.6248, longitude: 127.1764, towns: [{ name: '전동면', latitude: 36.6248, longitude: 127.1764 }] },
            { name: '소정면', latitude: 36.6631, longitude: 127.1368, towns: [{ name: '소정면', latitude: 36.6631, longitude: 127.1368 }] },
            { name: '한솔동', latitude: 36.5199, longitude: 127.2668, towns: [{ name: '한솔동', latitude: 36.5199, longitude: 127.2668 }] },
            { name: '새롬동', latitude: 36.5077, longitude: 127.2576, towns: [{ name: '새롬동', latitude: 36.5077, longitude: 127.2576 }] },
            { name: '도담동', latitude: 36.5028, longitude: 127.2839, towns: [{ name: '도담동', latitude: 36.5028, longitude: 127.2839 }] },
            { name: '아름동', latitude: 36.4947, longitude: 127.2840, towns: [{ name: '아름동', latitude: 36.4947, longitude: 127.2840 }] },
            { name: '종촌동', latitude: 36.4875, longitude: 127.2613, towns: [{ name: '종촌동', latitude: 36.4875, longitude: 127.2613 }] },
            { name: '고운동', latitude: 36.4773, longitude: 127.2729, towns: [{ name: '고운동', latitude: 36.4773, longitude: 127.2729 }] },
            { name: '소담동', latitude: 36.4667, longitude: 127.2907, towns: [{ name: '소담동', latitude: 36.4667, longitude: 127.2907 }] },
            { name: '보람동', latitude: 36.4605, longitude: 127.2997, towns: [{ name: '보람동', latitude: 36.4605, longitude: 127.2997 }] },
            { name: '대평동', latitude: 36.4476, longitude: 127.2915, towns: [{ name: '대평동', latitude: 36.4476, longitude: 127.2915 }] },
        ],
    },

    // ===== 경기도 =====
    {
        name: '경기도',
        short: '경기',
        latitude: 37.4138,
        longitude: 127.5183,
        cities: [
            { name: '가평군', latitude: 37.8315, longitude: 127.5099, towns: [{ name: '가평읍', latitude: 37.8315, longitude: 127.5099 }, { name: '청평면', latitude: 37.7783, longitude: 127.4996 }] },
            { name: '고양시', latitude: 37.6584, longitude: 126.8320, towns: [{ name: '일산동구', latitude: 37.6584, longitude: 126.8320 }, { name: '일산서구', latitude: 37.6684, longitude: 126.7773 }, { name: '덕양구', latitude: 37.6340, longitude: 126.8355 }] },
            { name: '과천시', latitude: 37.4291, longitude: 126.9876, towns: [{ name: '과천동', latitude: 37.4291, longitude: 126.9876 }, { name: '중앙동', latitude: 37.4338, longitude: 126.9941 }] },
            { name: '광명시', latitude: 37.4785, longitude: 126.8647, towns: [{ name: '광명동', latitude: 37.4785, longitude: 126.8647 }, { name: '철산동', latitude: 37.4815, longitude: 126.8636 }] },
            { name: '광주시', latitude: 37.4296, longitude: 127.2554, towns: [{ name: '경안동', latitude: 37.4296, longitude: 127.2554 }, { name: '오포읍', latitude: 37.3891, longitude: 127.2481 }, { name: '초월읍', latitude: 37.3711, longitude: 127.2890 }] },
            { name: '구리시', latitude: 37.5943, longitude: 127.1298, towns: [{ name: '인창동', latitude: 37.5943, longitude: 127.1298 }, { name: '교문동', latitude: 37.5949, longitude: 127.1380 }] },
            { name: '군포시', latitude: 37.3615, longitude: 126.9349, towns: [{ name: '산본동', latitude: 37.3615, longitude: 126.9349 }, { name: '당정동', latitude: 37.3650, longitude: 126.9493 }] },
            { name: '김포시', latitude: 37.6152, longitude: 126.7157, towns: [{ name: '사우동', latitude: 37.6152, longitude: 126.7157 }, { name: '장기동', latitude: 37.6441, longitude: 126.7224 }, { name: '통진읍', latitude: 37.6775, longitude: 126.6641 }] },
            { name: '남양주시', latitude: 37.6360, longitude: 127.2165, towns: [{ name: '금곡동', latitude: 37.6360, longitude: 127.2165 }, { name: '다산동', latitude: 37.5974, longitude: 127.1753 }, { name: '화도읍', latitude: 37.6631, longitude: 127.3093 }] },
            { name: '동두천시', latitude: 37.9038, longitude: 127.0607, towns: [{ name: '중앙동', latitude: 37.9038, longitude: 127.0607 }, { name: '생연동', latitude: 37.9057, longitude: 127.0513 }] },
            { name: '부천시', latitude: 37.5034, longitude: 126.7660, towns: [{ name: '소사구', latitude: 37.4846, longitude: 126.7809 }, { name: '오정구', latitude: 37.5113, longitude: 126.7882 }, { name: '원미구', latitude: 37.5034, longitude: 126.7660 }] },
            { name: '성남시', latitude: 37.4201, longitude: 127.1263, towns: [{ name: '분당구', latitude: 37.3825, longitude: 127.1225 }, { name: '수정구', latitude: 37.4492, longitude: 127.1382 }, { name: '중원구', latitude: 37.4434, longitude: 127.1479 }] },
            { name: '수원시', latitude: 37.2636, longitude: 127.0286, towns: [{ name: '장안구', latitude: 37.2934, longitude: 127.0095 }, { name: '권선구', latitude: 37.2596, longitude: 126.9972 }, { name: '팔달구', latitude: 37.2806, longitude: 127.0195 }, { name: '영통구', latitude: 37.2436, longitude: 127.0534 }] },
            { name: '시흥시', latitude: 37.3800, longitude: 126.8029, towns: [{ name: '정왕동', latitude: 37.3800, longitude: 126.8029 }, { name: '신천동', latitude: 37.4090, longitude: 126.8060 }, { name: '은행동', latitude: 37.4432, longitude: 126.7880 }] },
            { name: '안산시', latitude: 37.3219, longitude: 126.8309, towns: [{ name: '단원구', latitude: 37.3219, longitude: 126.8309 }, { name: '상록구', latitude: 37.2987, longitude: 126.8595 }] },
            { name: '안성시', latitude: 37.0080, longitude: 127.2797, towns: [{ name: '안성1동', latitude: 37.0080, longitude: 127.2797 }, { name: '공도읍', latitude: 37.0434, longitude: 127.2632 }, { name: '미양면', latitude: 37.0438, longitude: 127.3299 }] },
            { name: '안양시', latitude: 37.3943, longitude: 126.9568, towns: [{ name: '만안구', latitude: 37.3943, longitude: 126.9568 }, { name: '동안구', latitude: 37.3894, longitude: 126.9528 }] },
            { name: '양주시', latitude: 37.7853, longitude: 127.0459, towns: [{ name: '회천동', latitude: 37.7853, longitude: 127.0459 }, { name: '남면', latitude: 37.7371, longitude: 127.0271 }, { name: '광적면', latitude: 37.8087, longitude: 126.9948 }] },
            { name: '양평군', latitude: 37.4915, longitude: 127.4876, towns: [{ name: '양평읍', latitude: 37.4915, longitude: 127.4876 }, { name: '강상면', latitude: 37.4497, longitude: 127.4488 }, { name: '용문면', latitude: 37.5533, longitude: 127.5539 }] },
            { name: '여주시', latitude: 37.2983, longitude: 127.6377, towns: [{ name: '여주읍', latitude: 37.2983, longitude: 127.6377 }, { name: '가남읍', latitude: 37.2526, longitude: 127.5729 }] },
            { name: '연천군', latitude: 38.0965, longitude: 127.0749, towns: [{ name: '연천읍', latitude: 38.0965, longitude: 127.0749 }, { name: '전곡읍', latitude: 38.0124, longitude: 127.0575 }] },
            { name: '오산시', latitude: 37.1520, longitude: 127.0773, towns: [{ name: '오산동', latitude: 37.1520, longitude: 127.0773 }, { name: '원동', latitude: 37.1484, longitude: 127.0813 }] },
            { name: '용인시', latitude: 37.2411, longitude: 127.1775, towns: [{ name: '처인구', latitude: 37.2336, longitude: 127.1993 }, { name: '기흥구', latitude: 37.2753, longitude: 127.1147 }, { name: '수지구', latitude: 37.3213, longitude: 127.0968 }] },
            { name: '의왕시', latitude: 37.3444, longitude: 126.9686, towns: [{ name: '오전동', latitude: 37.3444, longitude: 126.9686 }, { name: '부곡동', latitude: 37.3355, longitude: 126.9715 }] },
            { name: '의정부시', latitude: 37.7381, longitude: 127.0474, towns: [{ name: '의정부동', latitude: 37.7381, longitude: 127.0474 }, { name: '금오동', latitude: 37.7412, longitude: 127.0403 }, { name: '민락동', latitude: 37.7595, longitude: 127.0760 }] },
            { name: '이천시', latitude: 37.2722, longitude: 127.4351, towns: [{ name: '이천동', latitude: 37.2722, longitude: 127.4351 }, { name: '부발읍', latitude: 37.2492, longitude: 127.4913 }, { name: '마장면', latitude: 37.2923, longitude: 127.4849 }] },
            { name: '파주시', latitude: 37.7601, longitude: 126.7800, towns: [{ name: '금촌동', latitude: 37.7601, longitude: 126.7800 }, { name: '교하동', latitude: 37.7452, longitude: 126.7637 }, { name: '운정동', latitude: 37.7250, longitude: 126.7489 }] },
            { name: '평택시', latitude: 36.9921, longitude: 127.1128, towns: [{ name: '평택동', latitude: 36.9921, longitude: 127.1128 }, { name: '안중읍', latitude: 36.9937, longitude: 126.9140 }, { name: '고덕면', latitude: 36.9498, longitude: 127.0953 }] },
            { name: '포천시', latitude: 37.8949, longitude: 127.2002, towns: [{ name: '포천동', latitude: 37.8949, longitude: 127.2002 }, { name: '소흘읍', latitude: 37.8420, longitude: 127.1631 }] },
            { name: '하남시', latitude: 37.5395, longitude: 127.2149, towns: [{ name: '덕풍동', latitude: 37.5395, longitude: 127.2149 }, { name: '미사동', latitude: 37.5649, longitude: 127.2034 }] },
            { name: '화성시', latitude: 37.1996, longitude: 126.8312, towns: [{ name: '봉담읍', latitude: 37.2196, longitude: 127.0117 }, { name: '동탄동', latitude: 37.2008, longitude: 127.0768 }, { name: '향남읍', latitude: 37.0980, longitude: 126.9625 }] },
        ],
    },

    // ===== 강원특별자치도 =====
    {
        name: '강원특별자치도',
        short: '강원',
        latitude: 37.8228,
        longitude: 128.1555,
        cities: [
            { name: '강릉시', latitude: 37.7519, longitude: 128.8760, towns: [{ name: '강릉시가지', latitude: 37.7519, longitude: 128.8760 }, { name: '주문진읍', latitude: 37.8965, longitude: 128.8212 }, { name: '옥계면', latitude: 37.6154, longitude: 129.0391 }] },
            { name: '고성군', latitude: 38.3800, longitude: 128.4675, towns: [{ name: '간성읍', latitude: 38.3800, longitude: 128.4675 }, { name: '거진읍', latitude: 38.4702, longitude: 128.4542 }] },
            { name: '동해시', latitude: 37.5247, longitude: 129.1143, towns: [{ name: '천곡동', latitude: 37.5247, longitude: 129.1143 }, { name: '북삼동', latitude: 37.5337, longitude: 129.1221 }] },
            { name: '삼척시', latitude: 37.4494, longitude: 129.1659, towns: [{ name: '삼척시가지', latitude: 37.4494, longitude: 129.1659 }, { name: '근덕면', latitude: 37.3665, longitude: 129.1939 }] },
            { name: '속초시', latitude: 38.2071, longitude: 128.5919, towns: [{ name: '속초시가지', latitude: 38.2071, longitude: 128.5919 }, { name: '조양동', latitude: 38.2086, longitude: 128.5916 }] },
            { name: '양구군', latitude: 38.1051, longitude: 127.9897, towns: [{ name: '양구읍', latitude: 38.1051, longitude: 127.9897 }] },
            { name: '양양군', latitude: 38.0756, longitude: 128.6194, towns: [{ name: '양양읍', latitude: 38.0756, longitude: 128.6194 }, { name: '손양면', latitude: 38.0346, longitude: 128.6015 }] },
            { name: '영월군', latitude: 37.1838, longitude: 128.4616, towns: [{ name: '영월읍', latitude: 37.1838, longitude: 128.4616 }, { name: '주천면', latitude: 37.2225, longitude: 128.2997 }] },
            { name: '원주시', latitude: 37.3422, longitude: 127.9202, towns: [{ name: '무실동', latitude: 37.3422, longitude: 127.9202 }, { name: '단계동', latitude: 37.3527, longitude: 127.9428 }, { name: '문막읍', latitude: 37.3018, longitude: 127.8234 }] },
            { name: '인제군', latitude: 38.0695, longitude: 128.1698, towns: [{ name: '인제읍', latitude: 38.0695, longitude: 128.1698 }, { name: '남면', latitude: 37.9564, longitude: 128.1574 }] },
            { name: '정선군', latitude: 37.3800, longitude: 128.6604, towns: [{ name: '정선읍', latitude: 37.3800, longitude: 128.6604 }, { name: '사북읍', latitude: 37.2618, longitude: 128.9009 }] },
            { name: '철원군', latitude: 38.1463, longitude: 127.3136, towns: [{ name: '철원읍', latitude: 38.1463, longitude: 127.3136 }, { name: '동송읍', latitude: 38.1979, longitude: 127.4195 }] },
            { name: '춘천시', latitude: 37.8813, longitude: 127.7298, towns: [{ name: '중앙로', latitude: 37.8813, longitude: 127.7298 }, { name: '후평동', latitude: 37.8753, longitude: 127.7445 }, { name: '소양로', latitude: 37.9012, longitude: 127.7343 }] },
            { name: '태백시', latitude: 37.1652, longitude: 128.9857, towns: [{ name: '황지동', latitude: 37.1652, longitude: 128.9857 }, { name: '장성동', latitude: 37.1759, longitude: 128.9809 }] },
            { name: '평창군', latitude: 37.3706, longitude: 128.3906, towns: [{ name: '평창읍', latitude: 37.3706, longitude: 128.3906 }, { name: '대화면', latitude: 37.4452, longitude: 128.4183 }] },
            { name: '홍천군', latitude: 37.6973, longitude: 127.8889, towns: [{ name: '홍천읍', latitude: 37.6973, longitude: 127.8889 }, { name: '화촌면', latitude: 37.6568, longitude: 128.0137 }] },
            { name: '화천군', latitude: 38.1065, longitude: 127.7076, towns: [{ name: '화천읍', latitude: 38.1065, longitude: 127.7076 }] },
            { name: '횡성군', latitude: 37.4917, longitude: 127.9849, towns: [{ name: '횡성읍', latitude: 37.4917, longitude: 127.9849 }, { name: '우천면', latitude: 37.5296, longitude: 128.1098 }] },
        ],
    },

    // ===== 충청북도 =====
    {
        name: '충청북도',
        short: '충북',
        latitude: 36.8000,
        longitude: 127.7000,
        cities: [
            { name: '괴산군', latitude: 36.8152, longitude: 127.7869, towns: [{ name: '괴산읍', latitude: 36.8152, longitude: 127.7869 }, { name: '사리면', latitude: 36.7685, longitude: 127.8143 }] },
            { name: '단양군', latitude: 36.9846, longitude: 128.3655, towns: [{ name: '단양읍', latitude: 36.9846, longitude: 128.3655 }, { name: '매포읍', latitude: 36.9688, longitude: 128.3219 }] },
            { name: '보은군', latitude: 36.4892, longitude: 127.7297, towns: [{ name: '보은읍', latitude: 36.4892, longitude: 127.7297 }, { name: '탄부면', latitude: 36.4543, longitude: 127.7543 }] },
            { name: '영동군', latitude: 36.1748, longitude: 127.7744, towns: [{ name: '영동읍', latitude: 36.1748, longitude: 127.7744 }, { name: '용산면', latitude: 36.2148, longitude: 127.7235 }] },
            { name: '옥천군', latitude: 36.3065, longitude: 127.5707, towns: [{ name: '옥천읍', latitude: 36.3065, longitude: 127.5707 }, { name: '이원면', latitude: 36.3368, longitude: 127.6485 }] },
            { name: '음성군', latitude: 36.9401, longitude: 127.6887, towns: [{ name: '음성읍', latitude: 36.9401, longitude: 127.6887 }, { name: '금왕읍', latitude: 37.0065, longitude: 127.5804 }, { name: '맹동면', latitude: 36.9773, longitude: 127.5948 }] },
            { name: '제천시', latitude: 37.1325, longitude: 128.1907, towns: [{ name: '제천시가지', latitude: 37.1325, longitude: 128.1907 }, { name: '금성면', latitude: 37.1538, longitude: 128.2547 }] },
            { name: '증평군', latitude: 36.7850, longitude: 127.5812, towns: [{ name: '증평읍', latitude: 36.7850, longitude: 127.5812 }] },
            { name: '진천군', latitude: 36.8553, longitude: 127.4354, towns: [{ name: '진천읍', latitude: 36.8553, longitude: 127.4354 }, { name: '이월면', latitude: 36.8911, longitude: 127.4776 }] },
            { name: '청주시', latitude: 36.6424, longitude: 127.4890, towns: [{ name: '상당구', latitude: 36.6424, longitude: 127.4890 }, { name: '서원구', latitude: 36.6179, longitude: 127.4593 }, { name: '청원구', latitude: 36.6756, longitude: 127.5147 }, { name: '흥덕구', latitude: 36.6377, longitude: 127.4270 }] },
            { name: '충주시', latitude: 36.9910, longitude: 127.9259, towns: [{ name: '충주시가지', latitude: 36.9910, longitude: 127.9259 }, { name: '중앙탑면', latitude: 36.9354, longitude: 127.8874 }, { name: '살미면', latitude: 36.9715, longitude: 127.9893 }] },
        ],
    },

    // ===== 충청남도 =====
    {
        name: '충청남도',
        short: '충남',
        latitude: 36.5184,
        longitude: 126.8000,
        cities: [
            { name: '계룡시', latitude: 36.2739, longitude: 127.2494, towns: [{ name: '금암동', latitude: 36.2739, longitude: 127.2494 }, { name: '두마면', latitude: 36.2886, longitude: 127.2258 }] },
            { name: '공주시', latitude: 36.4467, longitude: 127.1193, towns: [{ name: '공주시가지', latitude: 36.4467, longitude: 127.1193 }, { name: '신관동', latitude: 36.4553, longitude: 127.1318 }, { name: '유구읍', latitude: 36.5271, longitude: 127.0256 }] },
            { name: '금산군', latitude: 36.1090, longitude: 127.4881, towns: [{ name: '금산읍', latitude: 36.1090, longitude: 127.4881 }, { name: '남이면', latitude: 36.1432, longitude: 127.4508 }] },
            { name: '논산시', latitude: 36.1874, longitude: 127.0988, towns: [{ name: '논산시가지', latitude: 36.1874, longitude: 127.0988 }, { name: '연무읍', latitude: 36.1043, longitude: 127.1051 }, { name: '강경읍', latitude: 36.1607, longitude: 126.9920 }] },
            { name: '당진시', latitude: 36.8895, longitude: 126.6455, towns: [{ name: '당진1동', latitude: 36.8895, longitude: 126.6455 }, { name: '합덕읍', latitude: 36.8386, longitude: 126.7128 }, { name: '송악읍', latitude: 36.9494, longitude: 126.6576 }] },
            { name: '보령시', latitude: 36.3330, longitude: 126.6126, towns: [{ name: '보령시가지', latitude: 36.3330, longitude: 126.6126 }, { name: '웅천읍', latitude: 36.2885, longitude: 126.5588 }, { name: '대천동', latitude: 36.3483, longitude: 126.6126 }] },
            { name: '부여군', latitude: 36.2752, longitude: 126.9097, towns: [{ name: '부여읍', latitude: 36.2752, longitude: 126.9097 }, { name: '규암면', latitude: 36.3019, longitude: 126.8952 }] },
            { name: '서산시', latitude: 36.7849, longitude: 126.4503, towns: [{ name: '서산시가지', latitude: 36.7849, longitude: 126.4503 }, { name: '해미면', latitude: 36.7090, longitude: 126.5357 }, { name: '대산읍', latitude: 37.0018, longitude: 126.3700 }] },
            { name: '서천군', latitude: 36.0807, longitude: 126.6912, towns: [{ name: '서천읍', latitude: 36.0807, longitude: 126.6912 }, { name: '장항읍', latitude: 36.0003, longitude: 126.6767 }] },
            { name: '아산시', latitude: 36.7898, longitude: 127.0025, towns: [{ name: '온양1동', latitude: 36.7898, longitude: 127.0025 }, { name: '탕정면', latitude: 36.7614, longitude: 127.0693 }, { name: '배방읍', latitude: 36.7993, longitude: 127.0758 }] },
            { name: '예산군', latitude: 36.6802, longitude: 126.8446, towns: [{ name: '예산읍', latitude: 36.6802, longitude: 126.8446 }, { name: '삽교읍', latitude: 36.7515, longitude: 126.8789 }] },
            { name: '천안시', latitude: 36.8151, longitude: 127.1139, towns: [{ name: '동남구', latitude: 36.8086, longitude: 127.1494 }, { name: '서북구', latitude: 36.8347, longitude: 127.0948 }] },
            { name: '청양군', latitude: 36.4593, longitude: 126.7995, towns: [{ name: '청양읍', latitude: 36.4593, longitude: 126.7995 }] },
            { name: '태안군', latitude: 36.7456, longitude: 126.2980, towns: [{ name: '태안읍', latitude: 36.7456, longitude: 126.2980 }, { name: '안면읍', latitude: 36.5165, longitude: 126.3979 }] },
            { name: '홍성군', latitude: 36.6014, longitude: 126.6600, towns: [{ name: '홍성읍', latitude: 36.6014, longitude: 126.6600 }, { name: '광천읍', latitude: 36.5305, longitude: 126.6288 }, { name: '홍북읍', latitude: 36.6303, longitude: 126.6766 }] },
        ],
    },

    // ===== 전북특별자치도 =====
    {
        name: '전북특별자치도',
        short: '전북',
        latitude: 35.7175,
        longitude: 127.1530,
        cities: [
            { name: '고창군', latitude: 35.4350, longitude: 126.7022, towns: [{ name: '고창읍', latitude: 35.4350, longitude: 126.7022 }, { name: '흥덕면', latitude: 35.5147, longitude: 126.7363 }] },
            { name: '군산시', latitude: 35.9677, longitude: 126.7368, towns: [{ name: '군산시가지', latitude: 35.9677, longitude: 126.7368 }, { name: '나운동', latitude: 35.9677, longitude: 126.7368 }, { name: '소룡동', latitude: 35.9883, longitude: 126.7183 }] },
            { name: '김제시', latitude: 35.8033, longitude: 126.8806, towns: [{ name: '김제시가지', latitude: 35.8033, longitude: 126.8806 }, { name: '만경읍', latitude: 35.9028, longitude: 126.9152 }] },
            { name: '남원시', latitude: 35.4163, longitude: 127.3906, towns: [{ name: '남원시가지', latitude: 35.4163, longitude: 127.3906 }, { name: '주천면', latitude: 35.5092, longitude: 127.4273 }] },
            { name: '무주군', latitude: 36.0070, longitude: 127.6604, towns: [{ name: '무주읍', latitude: 36.0070, longitude: 127.6604 }, { name: '설천면', latitude: 35.9273, longitude: 127.6793 }] },
            { name: '부안군', latitude: 35.7317, longitude: 126.7332, towns: [{ name: '부안읍', latitude: 35.7317, longitude: 126.7332 }, { name: '변산면', latitude: 35.6851, longitude: 126.6037 }] },
            { name: '순창군', latitude: 35.3745, longitude: 127.1376, towns: [{ name: '순창읍', latitude: 35.3745, longitude: 127.1376 }, { name: '인계면', latitude: 35.4243, longitude: 127.0844 }] },
            { name: '완주군', latitude: 35.9054, longitude: 127.1619, towns: [{ name: '삼례읍', latitude: 35.9054, longitude: 127.1619 }, { name: '이서면', latitude: 35.8502, longitude: 127.0816 }, { name: '봉동읍', latitude: 35.9330, longitude: 127.0977 }] },
            { name: '익산시', latitude: 35.9483, longitude: 126.9578, towns: [{ name: '영등동', latitude: 35.9483, longitude: 126.9578 }, { name: '팔봉동', latitude: 35.9605, longitude: 126.9733 }, { name: '함열읍', latitude: 35.9834, longitude: 126.8637 }] },
            { name: '임실군', latitude: 35.6177, longitude: 127.2890, towns: [{ name: '임실읍', latitude: 35.6177, longitude: 127.2890 }, { name: '오수면', latitude: 35.5365, longitude: 127.3393 }] },
            { name: '장수군', latitude: 35.6472, longitude: 127.5210, towns: [{ name: '장수읍', latitude: 35.6472, longitude: 127.5210 }, { name: '번암면', latitude: 35.5458, longitude: 127.5654 }] },
            { name: '전주시', latitude: 35.8242, longitude: 127.1480, towns: [{ name: '완산구', latitude: 35.8033, longitude: 127.1367 }, { name: '덕진구', latitude: 35.8559, longitude: 127.1535 }] },
            { name: '정읍시', latitude: 35.5698, longitude: 126.8564, towns: [{ name: '정읍시가지', latitude: 35.5698, longitude: 126.8564 }, { name: '수성동', latitude: 35.5772, longitude: 126.8524 }, { name: '신태인읍', latitude: 35.6753, longitude: 126.8699 }] },
            { name: '진안군', latitude: 35.7914, longitude: 127.4241, towns: [{ name: '진안읍', latitude: 35.7914, longitude: 127.4241 }, { name: '마령면', latitude: 35.7531, longitude: 127.4721 }] },
        ],
    },

    // ===== 전라남도 =====
    {
        name: '전라남도',
        short: '전남',
        latitude: 34.8679,
        longitude: 126.9910,
        cities: [
            { name: '강진군', latitude: 34.6415, longitude: 126.7684, towns: [{ name: '강진읍', latitude: 34.6415, longitude: 126.7684 }, { name: '마량면', latitude: 34.5574, longitude: 126.7682 }] },
            { name: '고흥군', latitude: 34.6046, longitude: 127.2768, towns: [{ name: '고흥읍', latitude: 34.6046, longitude: 127.2768 }, { name: '도양읍', latitude: 34.5283, longitude: 127.2028 }] },
            { name: '곡성군', latitude: 35.2819, longitude: 127.2914, towns: [{ name: '곡성읍', latitude: 35.2819, longitude: 127.2914 }, { name: '옥과면', latitude: 35.2565, longitude: 127.1721 }] },
            { name: '광양시', latitude: 34.9409, longitude: 127.6956, towns: [{ name: '광양읍', latitude: 34.9409, longitude: 127.6956 }, { name: '태인동', latitude: 34.9615, longitude: 127.7235 }, { name: '금호동', latitude: 34.9758, longitude: 127.7023 }] },
            { name: '구례군', latitude: 35.2024, longitude: 127.4622, towns: [{ name: '구례읍', latitude: 35.2024, longitude: 127.4622 }, { name: '토지면', latitude: 35.2297, longitude: 127.5087 }] },
            { name: '나주시', latitude: 35.0160, longitude: 126.7109, towns: [{ name: '나주시가지', latitude: 35.0160, longitude: 126.7109 }, { name: '빛가람동', latitude: 35.0372, longitude: 126.7868 }, { name: '노안면', latitude: 35.0832, longitude: 126.6963 }] },
            { name: '담양군', latitude: 35.3215, longitude: 126.9882, towns: [{ name: '담양읍', latitude: 35.3215, longitude: 126.9882 }, { name: '대덕면', latitude: 35.2718, longitude: 126.9499 }] },
            { name: '목포시', latitude: 34.8118, longitude: 126.3922, towns: [{ name: '목포시가지', latitude: 34.8118, longitude: 126.3922 }, { name: '원산동', latitude: 34.8238, longitude: 126.4014 }, { name: '옥암동', latitude: 34.7945, longitude: 126.4247 }] },
            { name: '무안군', latitude: 34.9902, longitude: 126.4818, towns: [{ name: '무안읍', latitude: 34.9902, longitude: 126.4818 }, { name: '일로읍', latitude: 34.9199, longitude: 126.5256 }] },
            { name: '보성군', latitude: 34.7716, longitude: 127.0798, towns: [{ name: '보성읍', latitude: 34.7716, longitude: 127.0798 }, { name: '벌교읍', latitude: 34.8423, longitude: 127.3426 }] },
            { name: '순천시', latitude: 34.9506, longitude: 127.4875, towns: [{ name: '순천시가지', latitude: 34.9506, longitude: 127.4875 }, { name: '해룡면', latitude: 34.9048, longitude: 127.5418 }, { name: '조례동', latitude: 34.9634, longitude: 127.4892 }] },
            { name: '신안군', latitude: 34.8267, longitude: 126.1029, towns: [{ name: '지도읍', latitude: 34.8267, longitude: 126.1029 }, { name: '압해읍', latitude: 34.9034, longitude: 126.3327 }] },
            { name: '여수시', latitude: 34.7604, longitude: 127.6622, towns: [{ name: '여수시가지', latitude: 34.7604, longitude: 127.6622 }, { name: '돌산읍', latitude: 34.7195, longitude: 127.7218 }, { name: '율촌면', latitude: 34.9071, longitude: 127.6144 }] },
            { name: '영광군', latitude: 35.2774, longitude: 126.5119, towns: [{ name: '영광읍', latitude: 35.2774, longitude: 126.5119 }, { name: '법성면', latitude: 35.3256, longitude: 126.4775 }] },
            { name: '영암군', latitude: 34.7999, longitude: 126.6969, towns: [{ name: '영암읍', latitude: 34.7999, longitude: 126.6969 }, { name: '삼호읍', latitude: 34.8413, longitude: 126.5764 }] },
            { name: '완도군', latitude: 34.3111, longitude: 126.7553, towns: [{ name: '완도읍', latitude: 34.3111, longitude: 126.7553 }, { name: '금일읍', latitude: 34.4267, longitude: 127.0268 }] },
            { name: '장성군', latitude: 35.3024, longitude: 126.7894, towns: [{ name: '장성읍', latitude: 35.3024, longitude: 126.7894 }, { name: '황룡면', latitude: 35.2665, longitude: 126.7658 }] },
            { name: '장흥군', latitude: 34.6808, longitude: 126.9072, towns: [{ name: '장흥읍', latitude: 34.6808, longitude: 126.9072 }, { name: '관산읍', latitude: 34.6285, longitude: 126.9827 }] },
            { name: '진도군', latitude: 34.4877, longitude: 126.2633, towns: [{ name: '진도읍', latitude: 34.4877, longitude: 126.2633 }, { name: '군내면', latitude: 34.4899, longitude: 126.2956 }] },
            { name: '함평군', latitude: 35.0659, longitude: 126.5168, towns: [{ name: '함평읍', latitude: 35.0659, longitude: 126.5168 }, { name: '나산면', latitude: 35.0278, longitude: 126.5777 }] },
            { name: '해남군', latitude: 34.5738, longitude: 126.5989, towns: [{ name: '해남읍', latitude: 34.5738, longitude: 126.5989 }, { name: '삼산면', latitude: 34.4042, longitude: 126.5394 }] },
            { name: '화순군', latitude: 35.0648, longitude: 126.9869, towns: [{ name: '화순읍', latitude: 35.0648, longitude: 126.9869 }, { name: '능주면', latitude: 35.0138, longitude: 126.9285 }] },
        ],
    },

    // ===== 경상북도 =====
    {
        name: '경상북도',
        short: '경북',
        latitude: 36.4919,
        longitude: 128.8889,
        cities: [
            { name: '포항시', latitude: 36.0190, longitude: 129.3435, towns: [{ name: '남구', latitude: 35.9881, longitude: 129.3686 }, { name: '북구', latitude: 36.0325, longitude: 129.3298 }, { name: '오천읍', latitude: 36.0862, longitude: 129.3745 }] },
            { name: '경주시', latitude: 35.8562, longitude: 129.2247, towns: [{ name: '성건동', latitude: 35.8562, longitude: 129.2247 }, { name: '황성동', latitude: 35.8412, longitude: 129.2101 }, { name: '외동읍', latitude: 35.7891, longitude: 129.2948 }, { name: '내남면', latitude: 35.7798, longitude: 129.1832 }] },
            { name: '김천시', latitude: 36.1197, longitude: 128.1136, towns: [{ name: '김천시가지', latitude: 36.1197, longitude: 128.1136 }, { name: '아포읍', latitude: 36.1721, longitude: 128.1558 }, { name: '구성면', latitude: 36.0658, longitude: 128.0815 }] },
            { name: '안동시', latitude: 36.5684, longitude: 128.7294, towns: [{ name: '안동시가지', latitude: 36.5684, longitude: 128.7294 }, { name: '풍산읍', latitude: 36.5832, longitude: 128.5964 }, { name: '와룡면', latitude: 36.6347, longitude: 128.8012 }] },
            { name: '구미시', latitude: 36.1197, longitude: 128.3445, towns: [{ name: '구미시가지', latitude: 36.1197, longitude: 128.3445 }, { name: '산동읍', latitude: 36.1852, longitude: 128.3779 }, { name: '해평면', latitude: 36.1534, longitude: 128.4241 }, { name: '고아읍', latitude: 36.1038, longitude: 128.3012 }] },
            { name: '영주시', latitude: 36.8058, longitude: 128.6239, towns: [{ name: '영주시가지', latitude: 36.8058, longitude: 128.6239 }, { name: '풍기읍', latitude: 36.8432, longitude: 128.5073 }, { name: '이산면', latitude: 36.7856, longitude: 128.6784 }] },
            { name: '영천시', latitude: 35.9732, longitude: 128.9385, towns: [{ name: '영천시가지', latitude: 35.9732, longitude: 128.9385 }, { name: '금호읍', latitude: 35.9971, longitude: 128.8567 }, { name: '화남면', latitude: 35.9221, longitude: 128.9892 }] },
            { name: '상주시', latitude: 36.4110, longitude: 128.1590, towns: [{ name: '상주시가지', latitude: 36.4110, longitude: 128.1590 }, { name: '함창읍', latitude: 36.4921, longitude: 128.1262 }, { name: '낙동면', latitude: 36.3754, longitude: 128.2147 }] },
            { name: '문경시', latitude: 36.5863, longitude: 128.1867, towns: [{ name: '문경읍', latitude: 36.5863, longitude: 128.1867 }, { name: '점촌동', latitude: 36.6267, longitude: 128.1945 }, { name: '가은읍', latitude: 36.5637, longitude: 128.1301 }] },
            { name: '경산시', latitude: 35.8252, longitude: 128.7415, towns: [{ name: '경산시가지', latitude: 35.8252, longitude: 128.7415 }, { name: '압량읍', latitude: 35.8591, longitude: 128.7672 }, { name: '자인면', latitude: 35.8036, longitude: 128.8234 }] },
            { name: '군위군', latitude: 36.2392, longitude: 128.5718, towns: [{ name: '군위읍', latitude: 36.2392, longitude: 128.5718 }, { name: '의흥면', latitude: 36.2875, longitude: 128.5341 }] },
            { name: '의성군', latitude: 36.3527, longitude: 128.6970, towns: [{ name: '의성읍', latitude: 36.3527, longitude: 128.6970 }, { name: '금성면', latitude: 36.3892, longitude: 128.6516 }] },
            { name: '청송군', latitude: 36.4358, longitude: 129.0572, towns: [{ name: '청송읍', latitude: 36.4358, longitude: 129.0572 }, { name: '진보면', latitude: 36.5102, longitude: 129.1145 }] },
            { name: '영양군', latitude: 36.6668, longitude: 129.1128, towns: [{ name: '영양읍', latitude: 36.6668, longitude: 129.1128 }] },
            { name: '영덕군', latitude: 36.4155, longitude: 129.3654, towns: [{ name: '영덕읍', latitude: 36.4155, longitude: 129.3654 }, { name: '강구면', latitude: 36.3479, longitude: 129.3721 }] },
            { name: '청도군', latitude: 35.6473, longitude: 128.7347, towns: [{ name: '화양읍', latitude: 35.6473, longitude: 128.7347 }, { name: '청도읍', latitude: 35.6398, longitude: 128.7304 }] },
            { name: '고령군', latitude: 35.7275, longitude: 128.2639, towns: [{ name: '대가야읍', latitude: 35.7275, longitude: 128.2639 }, { name: '덕곡면', latitude: 35.7634, longitude: 128.3012 }] },
            { name: '성주군', latitude: 35.9199, longitude: 128.2828, towns: [{ name: '성주읍', latitude: 35.9199, longitude: 128.2828 }, { name: '선남면', latitude: 35.9548, longitude: 128.3256 }] },
            { name: '칠곡군', latitude: 35.9949, longitude: 128.4015, towns: [{ name: '왜관읍', latitude: 35.9949, longitude: 128.4015 }, { name: '석적읍', latitude: 35.9678, longitude: 128.4523 }, { name: '기산면', latitude: 36.0385, longitude: 128.3712 }] },
            { name: '예천군', latitude: 36.6548, longitude: 128.4518, towns: [{ name: '예천읍', latitude: 36.6548, longitude: 128.4518 }, { name: '호명면', latitude: 36.6915, longitude: 128.5012 }] },
            { name: '봉화군', latitude: 36.8932, longitude: 128.7321, towns: [{ name: '봉화읍', latitude: 36.8932, longitude: 128.7321 }, { name: '법전면', latitude: 36.8556, longitude: 128.6934 }] },
            { name: '울진군', latitude: 36.9930, longitude: 129.4004, towns: [{ name: '울진읍', latitude: 36.9930, longitude: 129.4004 }, { name: '평해읍', latitude: 36.7754, longitude: 129.3832 }, { name: '북면', latitude: 37.0856, longitude: 129.3671 }] },
            { name: '울릉군', latitude: 37.4845, longitude: 130.9057, towns: [{ name: '울릉읍', latitude: 37.4845, longitude: 130.9057 }] },
        ],
    },

    // ===== 경상남도 =====
    {
        name: '경상남도',
        short: '경남',
        latitude: 35.4606,
        longitude: 128.2132,
        cities: [
            { name: '창원시', latitude: 35.2280, longitude: 128.6811, towns: [{ name: '의창구', latitude: 35.2590, longitude: 128.6523 }, { name: '성산구', latitude: 35.2196, longitude: 128.6918 }, { name: '마산합포구', latitude: 35.1851, longitude: 128.5742 }, { name: '마산회원구', latitude: 35.2175, longitude: 128.5831 }, { name: '진해구', latitude: 35.1478, longitude: 128.6971 }] },
            { name: '진주시', latitude: 35.1799, longitude: 128.1076, towns: [{ name: '망경동', latitude: 35.1846, longitude: 128.0935 }, { name: '평거동', latitude: 35.1937, longitude: 128.0814 }, { name: '가좌동', latitude: 35.1580, longitude: 128.0701 }, { name: '금산면', latitude: 35.0895, longitude: 128.0620 }, { name: '진성면', latitude: 35.2397, longitude: 128.1501 }] },
            { name: '통영시', latitude: 34.8544, longitude: 128.4332, towns: [{ name: '도산면', latitude: 34.9012, longitude: 128.4631 }, { name: '광도면', latitude: 34.8893, longitude: 128.3985 }, { name: '용남면', latitude: 34.8635, longitude: 128.3782 }] },
            { name: '사천시', latitude: 35.0036, longitude: 128.0645, towns: [{ name: '사천읍', latitude: 35.0042, longitude: 128.0658 }, { name: '정동면', latitude: 35.0458, longitude: 128.1134 }, { name: '곤양면', latitude: 35.0521, longitude: 127.9973 }] },
            { name: '김해시', latitude: 35.2285, longitude: 128.8892, towns: [{ name: '장유동', latitude: 35.1726, longitude: 128.8277 }, { name: '진례면', latitude: 35.2600, longitude: 128.7989 }, { name: '한림면', latitude: 35.2812, longitude: 128.8545 }, { name: '생림면', latitude: 35.3074, longitude: 128.8797 }, { name: '상동면', latitude: 35.3312, longitude: 128.9256 }] },
            { name: '밀양시', latitude: 35.5038, longitude: 128.7460, towns: [{ name: '밀양시가지', latitude: 35.5038, longitude: 128.7460 }, { name: '삼랑진읍', latitude: 35.3907, longitude: 128.8177 }, { name: '하남읍', latitude: 35.4680, longitude: 128.8012 }, { name: '초동면', latitude: 35.4513, longitude: 128.7201 }] },
            { name: '거제시', latitude: 34.8799, longitude: 128.6211, towns: [{ name: '거제면', latitude: 34.8799, longitude: 128.6211 }, { name: '고현동', latitude: 34.8795, longitude: 128.6233 }, { name: '옥포동', latitude: 34.8949, longitude: 128.6942 }] },
            { name: '양산시', latitude: 35.3350, longitude: 129.0337, towns: [{ name: '양산시가지', latitude: 35.3350, longitude: 129.0337 }, { name: '물금읍', latitude: 35.2893, longitude: 128.9797 }, { name: '웅상읍', latitude: 35.3788, longitude: 129.0915 }] },
            { name: '의령군', latitude: 35.3222, longitude: 128.2615, towns: [{ name: '의령읍', latitude: 35.3222, longitude: 128.2615 }, { name: '부림면', latitude: 35.3498, longitude: 128.2042 }] },
            { name: '함안군', latitude: 35.2724, longitude: 128.4062, towns: [{ name: '가야읍', latitude: 35.2724, longitude: 128.4062 }, { name: '칠원읍', latitude: 35.2476, longitude: 128.4789 }, { name: '군북면', latitude: 35.3087, longitude: 128.3412 }] },
            { name: '창녕군', latitude: 35.5445, longitude: 128.4924, towns: [{ name: '창녕읍', latitude: 35.5445, longitude: 128.4924 }, { name: '남지읍', latitude: 35.4148, longitude: 128.4019 }, { name: '대합면', latitude: 35.5712, longitude: 128.5348 }] },
            { name: '고성군', latitude: 34.9732, longitude: 128.3229, towns: [{ name: '고성읍', latitude: 34.9732, longitude: 128.3229 }, { name: '회화면', latitude: 35.0248, longitude: 128.4015 }] },
            { name: '남해군', latitude: 34.8375, longitude: 127.8923, towns: [{ name: '남해읍', latitude: 34.8375, longitude: 127.8923 }, { name: '설천면', latitude: 34.8804, longitude: 127.9156 }] },
            { name: '하동군', latitude: 35.0668, longitude: 127.7516, towns: [{ name: '하동읍', latitude: 35.0668, longitude: 127.7516 }, { name: '금남면', latitude: 35.0058, longitude: 127.7893 }] },
            { name: '산청군', latitude: 35.4155, longitude: 127.8733, towns: [{ name: '산청읍', latitude: 35.4155, longitude: 127.8733 }, { name: '단성면', latitude: 35.3365, longitude: 127.9232 }] },
            { name: '함양군', latitude: 35.5196, longitude: 127.7252, towns: [{ name: '함양읍', latitude: 35.5196, longitude: 127.7252 }, { name: '지곡면', latitude: 35.5521, longitude: 127.7679 }] },
            { name: '거창군', latitude: 35.6868, longitude: 127.9097, towns: [{ name: '거창읍', latitude: 35.6868, longitude: 127.9097 }, { name: '웅양면', latitude: 35.7385, longitude: 127.8612 }] },
            { name: '합천군', latitude: 35.5665, longitude: 128.1656, towns: [{ name: '합천읍', latitude: 35.5665, longitude: 128.1656 }, { name: '쌍백면', latitude: 35.5138, longitude: 128.2044 }] },
        ],
    },

    // ===== 제주특별자치도 =====
    {
        name: '제주특별자치도',
        short: '제주',
        latitude: 33.4996,
        longitude: 126.5312,
        cities: [
            { name: '제주시', latitude: 33.4996, longitude: 126.5312, towns: [{ name: '이도1동', latitude: 33.5097, longitude: 126.5219 }, { name: '노형동', latitude: 33.4897, longitude: 126.4752 }, { name: '아라동', latitude: 33.4725, longitude: 126.5432 }, { name: '한림읍', latitude: 33.4130, longitude: 126.2680 }, { name: '애월읍', latitude: 33.4628, longitude: 126.3302 }, { name: '조천읍', latitude: 33.5274, longitude: 126.6413 }, { name: '구좌읍', latitude: 33.5460, longitude: 126.7923 }] },
            { name: '서귀포시', latitude: 33.2541, longitude: 126.5600, towns: [{ name: '서귀동', latitude: 33.2541, longitude: 126.5600 }, { name: '중앙동', latitude: 33.2520, longitude: 126.5611 }, { name: '대천동', latitude: 33.3085, longitude: 126.5096 }, { name: '표선면', latitude: 33.3242, longitude: 126.8222 }, { name: '남원읍', latitude: 33.2888, longitude: 126.7139 }, { name: '성산읍', latitude: 33.4368, longitude: 126.9173 }, { name: '안덕면', latitude: 33.3187, longitude: 126.3550 }, { name: '대정읍', latitude: 33.2361, longitude: 126.2497 }] },
        ],
    },
];

// 지역 선택 시 지도 이동 줌 레벨
export const ZOOM_LEVEL = {
    province: { latitudeDelta: 0.8, longitudeDelta: 0.8 },   // 도 단위
    city: { latitudeDelta: 0.08, longitudeDelta: 0.08 },      // 시군구 단위
    town: { latitudeDelta: 0.02, longitudeDelta: 0.02 },      // 읍면동 단위
};
