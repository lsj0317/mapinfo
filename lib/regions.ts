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
    {
        name: '경상남도',
        short: '경남',
        latitude: 35.4606,
        longitude: 128.2132,
        cities: [
            {
                name: '창원시',
                latitude: 35.2280,
                longitude: 128.6811,
                towns: [
                    { name: '의창구', latitude: 35.2590, longitude: 128.6523 },
                    { name: '성산구', latitude: 35.2196, longitude: 128.6918 },
                    { name: '마산합포구', latitude: 35.1851, longitude: 128.5742 },
                    { name: '마산회원구', latitude: 35.2175, longitude: 128.5831 },
                    { name: '진해구', latitude: 35.1478, longitude: 128.6971 },
                ],
            },
            {
                name: '진주시',
                latitude: 35.1799,
                longitude: 128.1076,
                towns: [
                    { name: '망경동', latitude: 35.1846, longitude: 128.0935 },
                    { name: '평거동', latitude: 35.1937, longitude: 128.0814 },
                    { name: '가좌동', latitude: 35.1580, longitude: 128.0701 },
                    { name: '금산면', latitude: 35.0895, longitude: 128.0620 },
                    { name: '진성면', latitude: 35.2397, longitude: 128.1501 },
                ],
            },
            {
                name: '통영시',
                latitude: 34.8544,
                longitude: 128.4332,
                towns: [
                    { name: '도산면', latitude: 34.9012, longitude: 128.4631 },
                    { name: '광도면', latitude: 34.8893, longitude: 128.3985 },
                    { name: '용남면', latitude: 34.8635, longitude: 128.3782 },
                ],
            },
            {
                name: '사천시',
                latitude: 35.0036,
                longitude: 128.0645,
                towns: [
                    { name: '사천읍', latitude: 35.0042, longitude: 128.0658 },
                    { name: '정동면', latitude: 35.0458, longitude: 128.1134 },
                    { name: '곤양면', latitude: 35.0521, longitude: 127.9973 },
                ],
            },
            {
                name: '김해시',
                latitude: 35.2285,
                longitude: 128.8892,
                towns: [
                    { name: '장유동', latitude: 35.1726, longitude: 128.8277 },
                    { name: '진례면', latitude: 35.2600, longitude: 128.7989 },
                    { name: '한림면', latitude: 35.2812, longitude: 128.8545 },
                    { name: '생림면', latitude: 35.3074, longitude: 128.8797 },
                    { name: '상동면', latitude: 35.3312, longitude: 128.9256 },
                ],
            },
            {
                name: '밀양시',
                latitude: 35.5038,
                longitude: 128.7460,
                towns: [
                    { name: '밀양시가지', latitude: 35.5038, longitude: 128.7460 },
                    { name: '삼랑진읍', latitude: 35.3907, longitude: 128.8177 },
                    { name: '하남읍', latitude: 35.4680, longitude: 128.8012 },
                    { name: '초동면', latitude: 35.4513, longitude: 128.7201 },
                ],
            },
            {
                name: '거제시',
                latitude: 34.8799,
                longitude: 128.6211,
                towns: [
                    { name: '거제면', latitude: 34.8799, longitude: 128.6211 },
                    { name: '고현동', latitude: 34.8795, longitude: 128.6233 },
                    { name: '옥포동', latitude: 34.8949, longitude: 128.6942 },
                ],
            },
            {
                name: '양산시',
                latitude: 35.3350,
                longitude: 129.0337,
                towns: [
                    { name: '양산시가지', latitude: 35.3350, longitude: 129.0337 },
                    { name: '물금읍', latitude: 35.2893, longitude: 128.9797 },
                    { name: '웅상읍', latitude: 35.3788, longitude: 129.0915 },
                ],
            },
            {
                name: '의령군',
                latitude: 35.3222,
                longitude: 128.2615,
                towns: [
                    { name: '의령읍', latitude: 35.3222, longitude: 128.2615 },
                    { name: '부림면', latitude: 35.3498, longitude: 128.2042 },
                ],
            },
            {
                name: '함안군',
                latitude: 35.2724,
                longitude: 128.4062,
                towns: [
                    { name: '가야읍', latitude: 35.2724, longitude: 128.4062 },
                    { name: '칠원읍', latitude: 35.2476, longitude: 128.4789 },
                    { name: '군북면', latitude: 35.3087, longitude: 128.3412 },
                ],
            },
            {
                name: '창녕군',
                latitude: 35.5445,
                longitude: 128.4924,
                towns: [
                    { name: '창녕읍', latitude: 35.5445, longitude: 128.4924 },
                    { name: '남지읍', latitude: 35.4148, longitude: 128.4019 },
                    { name: '대합면', latitude: 35.5712, longitude: 128.5348 },
                ],
            },
            {
                name: '고성군',
                latitude: 34.9732,
                longitude: 128.3229,
                towns: [
                    { name: '고성읍', latitude: 34.9732, longitude: 128.3229 },
                    { name: '회화면', latitude: 35.0248, longitude: 128.4015 },
                ],
            },
            {
                name: '남해군',
                latitude: 34.8375,
                longitude: 127.8923,
                towns: [
                    { name: '남해읍', latitude: 34.8375, longitude: 127.8923 },
                    { name: '설천면', latitude: 34.8804, longitude: 127.9156 },
                ],
            },
            {
                name: '하동군',
                latitude: 35.0668,
                longitude: 127.7516,
                towns: [
                    { name: '하동읍', latitude: 35.0668, longitude: 127.7516 },
                    { name: '금남면', latitude: 35.0058, longitude: 127.7893 },
                ],
            },
            {
                name: '산청군',
                latitude: 35.4155,
                longitude: 127.8733,
                towns: [
                    { name: '산청읍', latitude: 35.4155, longitude: 127.8733 },
                    { name: '단성면', latitude: 35.3365, longitude: 127.9232 },
                ],
            },
            {
                name: '함양군',
                latitude: 35.5196,
                longitude: 127.7252,
                towns: [
                    { name: '함양읍', latitude: 35.5196, longitude: 127.7252 },
                    { name: '지곡면', latitude: 35.5521, longitude: 127.7679 },
                ],
            },
            {
                name: '거창군',
                latitude: 35.6868,
                longitude: 127.9097,
                towns: [
                    { name: '거창읍', latitude: 35.6868, longitude: 127.9097 },
                    { name: '웅양면', latitude: 35.7385, longitude: 127.8612 },
                ],
            },
            {
                name: '합천군',
                latitude: 35.5665,
                longitude: 128.1656,
                towns: [
                    { name: '합천읍', latitude: 35.5665, longitude: 128.1656 },
                    { name: '쌍백면', latitude: 35.5138, longitude: 128.2044 },
                ],
            },
        ],
    },
    {
        name: '경상북도',
        short: '경북',
        latitude: 36.4919,
        longitude: 128.8889,
        cities: [
            {
                name: '포항시',
                latitude: 36.0190,
                longitude: 129.3435,
                towns: [
                    { name: '남구', latitude: 35.9881, longitude: 129.3686 },
                    { name: '북구', latitude: 36.0325, longitude: 129.3298 },
                    { name: '오천읍', latitude: 36.0862, longitude: 129.3745 },
                ],
            },
            {
                name: '경주시',
                latitude: 35.8562,
                longitude: 129.2247,
                towns: [
                    { name: '성건동', latitude: 35.8562, longitude: 129.2247 },
                    { name: '황성동', latitude: 35.8412, longitude: 129.2101 },
                    { name: '외동읍', latitude: 35.7891, longitude: 129.2948 },
                    { name: '내남면', latitude: 35.7798, longitude: 129.1832 },
                ],
            },
            {
                name: '김천시',
                latitude: 36.1197,
                longitude: 128.1136,
                towns: [
                    { name: '김천시가지', latitude: 36.1197, longitude: 128.1136 },
                    { name: '아포읍', latitude: 36.1721, longitude: 128.1558 },
                    { name: '구성면', latitude: 36.0658, longitude: 128.0815 },
                ],
            },
            {
                name: '안동시',
                latitude: 36.5684,
                longitude: 128.7294,
                towns: [
                    { name: '안동시가지', latitude: 36.5684, longitude: 128.7294 },
                    { name: '풍산읍', latitude: 36.5832, longitude: 128.5964 },
                    { name: '와룡면', latitude: 36.6347, longitude: 128.8012 },
                ],
            },
            {
                name: '구미시',
                latitude: 36.1197,
                longitude: 128.3445,
                towns: [
                    { name: '구미시가지', latitude: 36.1197, longitude: 128.3445 },
                    { name: '산동읍', latitude: 36.1852, longitude: 128.3779 },
                    { name: '해평면', latitude: 36.1534, longitude: 128.4241 },
                    { name: '고아읍', latitude: 36.1038, longitude: 128.3012 },
                ],
            },
            {
                name: '영주시',
                latitude: 36.8058,
                longitude: 128.6239,
                towns: [
                    { name: '영주시가지', latitude: 36.8058, longitude: 128.6239 },
                    { name: '풍기읍', latitude: 36.8432, longitude: 128.5073 },
                    { name: '이산면', latitude: 36.7856, longitude: 128.6784 },
                ],
            },
            {
                name: '영천시',
                latitude: 35.9732,
                longitude: 128.9385,
                towns: [
                    { name: '영천시가지', latitude: 35.9732, longitude: 128.9385 },
                    { name: '금호읍', latitude: 35.9971, longitude: 128.8567 },
                    { name: '화남면', latitude: 35.9221, longitude: 128.9892 },
                ],
            },
            {
                name: '상주시',
                latitude: 36.4110,
                longitude: 128.1590,
                towns: [
                    { name: '상주시가지', latitude: 36.4110, longitude: 128.1590 },
                    { name: '함창읍', latitude: 36.4921, longitude: 128.1262 },
                    { name: '낙동면', latitude: 36.3754, longitude: 128.2147 },
                ],
            },
            {
                name: '문경시',
                latitude: 36.5863,
                longitude: 128.1867,
                towns: [
                    { name: '문경읍', latitude: 36.5863, longitude: 128.1867 },
                    { name: '점촌동', latitude: 36.6267, longitude: 128.1945 },
                    { name: '가은읍', latitude: 36.5637, longitude: 128.1301 },
                ],
            },
            {
                name: '경산시',
                latitude: 35.8252,
                longitude: 128.7415,
                towns: [
                    { name: '경산시가지', latitude: 35.8252, longitude: 128.7415 },
                    { name: '압량읍', latitude: 35.8591, longitude: 128.7672 },
                    { name: '자인면', latitude: 35.8036, longitude: 128.8234 },
                ],
            },
            {
                name: '군위군',
                latitude: 36.2392,
                longitude: 128.5718,
                towns: [
                    { name: '군위읍', latitude: 36.2392, longitude: 128.5718 },
                    { name: '의흥면', latitude: 36.2875, longitude: 128.5341 },
                ],
            },
            {
                name: '의성군',
                latitude: 36.3527,
                longitude: 128.6970,
                towns: [
                    { name: '의성읍', latitude: 36.3527, longitude: 128.6970 },
                    { name: '금성면', latitude: 36.3892, longitude: 128.6516 },
                ],
            },
            {
                name: '청송군',
                latitude: 36.4358,
                longitude: 129.0572,
                towns: [
                    { name: '청송읍', latitude: 36.4358, longitude: 129.0572 },
                    { name: '진보면', latitude: 36.5102, longitude: 129.1145 },
                ],
            },
            {
                name: '영양군',
                latitude: 36.6668,
                longitude: 129.1128,
                towns: [
                    { name: '영양읍', latitude: 36.6668, longitude: 129.1128 },
                ],
            },
            {
                name: '영덕군',
                latitude: 36.4155,
                longitude: 129.3654,
                towns: [
                    { name: '영덕읍', latitude: 36.4155, longitude: 129.3654 },
                    { name: '강구면', latitude: 36.3479, longitude: 129.3721 },
                ],
            },
            {
                name: '청도군',
                latitude: 35.6473,
                longitude: 128.7347,
                towns: [
                    { name: '화양읍', latitude: 35.6473, longitude: 128.7347 },
                    { name: '청도읍', latitude: 35.6398, longitude: 128.7304 },
                ],
            },
            {
                name: '고령군',
                latitude: 35.7275,
                longitude: 128.2639,
                towns: [
                    { name: '대가야읍', latitude: 35.7275, longitude: 128.2639 },
                    { name: '덕곡면', latitude: 35.7634, longitude: 128.3012 },
                ],
            },
            {
                name: '성주군',
                latitude: 35.9199,
                longitude: 128.2828,
                towns: [
                    { name: '성주읍', latitude: 35.9199, longitude: 128.2828 },
                    { name: '선남면', latitude: 35.9548, longitude: 128.3256 },
                ],
            },
            {
                name: '칠곡군',
                latitude: 35.9949,
                longitude: 128.4015,
                towns: [
                    { name: '왜관읍', latitude: 35.9949, longitude: 128.4015 },
                    { name: '석적읍', latitude: 35.9678, longitude: 128.4523 },
                    { name: '기산면', latitude: 36.0385, longitude: 128.3712 },
                ],
            },
            {
                name: '예천군',
                latitude: 36.6548,
                longitude: 128.4518,
                towns: [
                    { name: '예천읍', latitude: 36.6548, longitude: 128.4518 },
                    { name: '호명면', latitude: 36.6915, longitude: 128.5012 },
                ],
            },
            {
                name: '봉화군',
                latitude: 36.8932,
                longitude: 128.7321,
                towns: [
                    { name: '봉화읍', latitude: 36.8932, longitude: 128.7321 },
                    { name: '법전면', latitude: 36.8556, longitude: 128.6934 },
                ],
            },
            {
                name: '울진군',
                latitude: 36.9930,
                longitude: 129.4004,
                towns: [
                    { name: '울진읍', latitude: 36.9930, longitude: 129.4004 },
                    { name: '평해읍', latitude: 36.7754, longitude: 129.3832 },
                    { name: '북면', latitude: 37.0856, longitude: 129.3671 },
                ],
            },
            {
                name: '울릉군',
                latitude: 37.4845,
                longitude: 130.9057,
                towns: [
                    { name: '울릉읍', latitude: 37.4845, longitude: 130.9057 },
                ],
            },
        ],
    },
    // 추후 전국 확장 가능한 구조
    {
        name: '서울특별시',
        short: '서울',
        latitude: 37.5665,
        longitude: 126.9780,
        cities: [
            { name: '강남구', latitude: 37.5172, longitude: 127.0473, towns: [{ name: '역삼동', latitude: 37.5006, longitude: 127.0369 }, { name: '삼성동', latitude: 37.5140, longitude: 127.0567 }] },
            { name: '강서구', latitude: 37.5509, longitude: 126.8497, towns: [{ name: '화곡동', latitude: 37.5477, longitude: 126.8498 }, { name: '등촌동', latitude: 37.5524, longitude: 126.8617 }] },
            { name: '중구', latitude: 37.5640, longitude: 126.9975, towns: [{ name: '명동', latitude: 37.5636, longitude: 126.9832 }, { name: '을지로동', latitude: 37.5662, longitude: 126.9997 }] },
        ],
    },
    {
        name: '부산광역시',
        short: '부산',
        latitude: 35.1796,
        longitude: 129.0756,
        cities: [
            { name: '해운대구', latitude: 35.1628, longitude: 129.1635, towns: [{ name: '해운대동', latitude: 35.1588, longitude: 129.1601 }, { name: '재송동', latitude: 35.1968, longitude: 129.1093 }] },
            { name: '사상구', latitude: 35.1521, longitude: 128.9941, towns: [{ name: '괘법동', latitude: 35.1544, longitude: 128.9934 }, { name: '주례동', latitude: 35.1617, longitude: 128.9813 }] },
            { name: '강서구', latitude: 35.2120, longitude: 128.9808, towns: [{ name: '명지동', latitude: 35.1005, longitude: 128.9453 }, { name: '가락동', latitude: 35.2337, longitude: 128.9632 }] },
            { name: '기장군', latitude: 35.2445, longitude: 129.2224, towns: [{ name: '기장읍', latitude: 35.2445, longitude: 129.2224 }, { name: '정관읍', latitude: 35.3009, longitude: 129.1693 }] },
        ],
    },
    {
        name: '대구광역시',
        short: '대구',
        latitude: 35.8714,
        longitude: 128.6014,
        cities: [
            { name: '달성군', latitude: 35.7751, longitude: 128.4313, towns: [{ name: '현풍읍', latitude: 35.6491, longitude: 128.4271 }, { name: '유가읍', latitude: 35.7135, longitude: 128.4582 }] },
            { name: '북구', latitude: 35.8849, longitude: 128.5828, towns: [{ name: '산격동', latitude: 35.8858, longitude: 128.5943 }, { name: '검단동', latitude: 35.9258, longitude: 128.5721 }] },
        ],
    },
    {
        name: '전라남도',
        short: '전남',
        latitude: 34.8679,
        longitude: 126.9910,
        cities: [
            { name: '여수시', latitude: 34.7604, longitude: 127.6622, towns: [{ name: '여수시가지', latitude: 34.7604, longitude: 127.6622 }, { name: '돌산읍', latitude: 34.7195, longitude: 127.7218 }] },
            { name: '순천시', latitude: 34.9506, longitude: 127.4875, towns: [{ name: '순천시가지', latitude: 34.9506, longitude: 127.4875 }, { name: '해룡면', latitude: 34.9048, longitude: 127.5418 }] },
            { name: '광양시', latitude: 34.9409, longitude: 127.6956, towns: [{ name: '광양읍', latitude: 34.9409, longitude: 127.6956 }, { name: '태인동', latitude: 34.9615, longitude: 127.7235 }] },
        ],
    },
    {
        name: '충청남도',
        short: '충남',
        latitude: 36.5184,
        longitude: 126.8000,
        cities: [
            { name: '천안시', latitude: 36.8151, longitude: 127.1139, towns: [{ name: '동남구', latitude: 36.8086, longitude: 127.1494 }, { name: '서북구', latitude: 36.8347, longitude: 127.0948 }] },
            { name: '아산시', latitude: 36.7898, longitude: 127.0025, towns: [{ name: '아산시가지', latitude: 36.7898, longitude: 127.0025 }, { name: '탕정면', latitude: 36.7614, longitude: 127.0693 }] },
        ],
    },
];

// 지역 선택 시 지도 이동 줌 레벨
export const ZOOM_LEVEL = {
    province: { latitudeDelta: 0.8, longitudeDelta: 0.8 },   // 도 단위
    city: { latitudeDelta: 0.08, longitudeDelta: 0.08 },      // 시군구 단위
    town: { latitudeDelta: 0.02, longitudeDelta: 0.02 },      // 읍면동 단위
};
