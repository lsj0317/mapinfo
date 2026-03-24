/**
 * KakaoSkyView.tsx
 * 카카오 스카이뷰(항공사진) 전용 지도 컴포넌트
 * - Kakao Maps JS SDK WebView 기반
 * - 한국 최신 항공사진 (구글 대비 갱신 주기 짧음)
 * - 마커, 위치 이동, 클릭 이벤트 지원
 */
import React, { forwardRef, useImperativeHandle, useRef, useCallback, useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { KAKAO_API_KEY } from '@env';

export interface KakaoSkyViewHandle {
    animateToRegion: (region: MapRegion, duration?: number) => void;
}

export interface MapRegion {
    latitude: number;
    longitude: number;
    latitudeDelta: number;
    longitudeDelta: number;
}

export interface SkyMarkerItem {
    id: string;
    latitude: number;
    longitude: number;
    type: 'building' | 'property' | 'cluster';
    color?: string;
    title?: string;
    count?: number;
}

interface Props {
    style?: object;
    initialRegion: MapRegion;
    onRegionChangeComplete?: (region: MapRegion) => void;
    onPress?: (coordinate: { latitude: number; longitude: number }) => void;
    onMarkerPress?: (id: string, markerType: string) => void;
    markers?: SkyMarkerItem[];
    selectedMarker?: { latitude: number; longitude: number } | null;
    userLocation?: { latitude: number; longitude: number } | null;
    onLoadProgress?: (stage: 'sdkLoaded' | 'mapReady') => void;
}

// latitudeDelta → Kakao 레벨 변환
function latDeltaToLevel(delta: number): number {
    if (delta < 0.0007) return 1;
    if (delta < 0.0015) return 2;
    if (delta < 0.003)  return 3;
    if (delta < 0.006)  return 4;
    if (delta < 0.012)  return 5;
    if (delta < 0.024)  return 6;
    if (delta < 0.048)  return 7;
    if (delta < 0.10)   return 8;
    if (delta < 0.20)   return 9;
    if (delta < 0.40)   return 10;
    if (delta < 0.80)   return 11;
    if (delta < 1.60)   return 12;
    return 13;
}

// Kakao 레벨 → latitudeDelta 변환
const LEVEL_TO_LAT_DELTA = [0, 0.0005, 0.001, 0.002, 0.004, 0.008, 0.016, 0.032, 0.07, 0.15, 0.3, 0.6, 1.2, 2.0];
function levelToLatDelta(level: number): number {
    return LEVEL_TO_LAT_DELTA[Math.min(Math.max(level, 1), 13)] ?? 0.002;
}

function buildHTML(apiKey: string, region: MapRegion): string {
    const lat = region.latitude;
    const lng = region.longitude;
    const level = latDeltaToLevel(region.latitudeDelta);

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body, #map { width:100%; height:100%; overflow:hidden; }
</style>
</head>
<body>
<div id="map"></div>
<script>
  var _markers = {};
  var _selectedOverlay = null;
  var _userMarker = null;
  var _map = null;
  var _ready = false;

  function postRN(obj) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(obj)); } catch(e) {}
  }

  // 스카이뷰 레이어 토글 (지적도 오버레이 포함)
  var _cadastralOverlay = null;
  function setCadastralOverlay(show) {
    if (!_map) return;
    if (show) {
      if (!_cadastralOverlay) {
        _cadastralOverlay = new kakao.maps.TileImage(
          'http://map{SIGN}.daumcdn.net/map_hybrid/1.1/L{LEVEL}/{y}/{x}.png',
          new kakao.maps.Size(256, 256)
        );
      }
    }
  }

  function initMap() {
    var container = document.getElementById('map');
    var options = {
      center: new kakao.maps.LatLng(${lat}, ${lng}),
      level: ${level},
      mapTypeId: kakao.maps.MapTypeId.SKYVIEW
    };
    _map = new kakao.maps.Map(container, options);
    _ready = true;

    postRN({ type: 'sdkLoaded' });
    postRN({ type: 'mapReady' });

    // 지도 클릭 이벤트
    kakao.maps.event.addListener(_map, 'click', function(mouseEvent) {
      var latlng = mouseEvent.latLng;
      postRN({ type: 'mapPress', lat: latlng.getLat(), lng: latlng.getLng() });
    });

    // 지도 이동 완료 이벤트
    kakao.maps.event.addListener(_map, 'idle', function() {
      var center = _map.getCenter();
      var level = _map.getLevel();
      postRN({
        type: 'regionChange',
        lat: center.getLat(),
        lng: center.getLng(),
        level: level
      });
    });
  }

  // 마커 설정 (전체 교체)
  function rnSetMarkers(jsonStr) {
    if (!_map || !_ready) return;
    var items = JSON.parse(jsonStr);

    // 기존 마커 제거
    Object.values(_markers).forEach(function(m) { m.setMap(null); });
    _markers = {};

    items.forEach(function(item) {
      var pos = new kakao.maps.LatLng(item.latitude, item.longitude);
      var color = item.color || '#FF5722';

      // 커스텀 오버레이 (색상 원형 마커)
      var size = item.type === 'cluster' ? 36 : 28;
      var label = item.type === 'cluster' ? (item.count || '') : '';
      var content = [
        '<div style="',
          'width:' + size + 'px;height:' + size + 'px;',
          'background:' + color + ';',
          'border-radius:50%;',
          'border:2.5px solid #fff;',
          'box-shadow:0 2px 6px rgba(0,0,0,0.45);',
          'display:flex;align-items:center;justify-content:center;',
          'cursor:pointer;',
          'font-size:11px;font-weight:700;color:#fff;',
        '">' + label + '</div>'
      ].join('');

      var overlay = new kakao.maps.CustomOverlay({
        map: _map,
        position: pos,
        content: content,
        yAnchor: 0.5,
        xAnchor: 0.5,
        zIndex: 10
      });

      // 클릭 이벤트 (CustomOverlay는 DOM 이벤트 사용)
      (function(id, type) {
        overlay.getContent = function() { return content; };
        try {
          setTimeout(function() {
            var el = overlay.a || overlay.cc;
            if (el) {
              el.addEventListener('click', function(e) {
                e.stopPropagation();
                postRN({ type: 'markerPress', id: id, markerType: type });
              });
            }
          }, 100);
        } catch(e) {}
      })(item.id, item.type);

      _markers[item.id] = overlay;
    });
  }

  // 지도 이동
  function rnMoveTo(lat, lng, level) {
    if (!_map || !_ready) return;
    var pos = new kakao.maps.LatLng(lat, lng);
    _map.setCenter(pos);
    if (level) _map.setLevel(level, { animate: true });
  }

  // 선택 마커 (파란 핀)
  function rnSetSelectedMarker(lat, lng) {
    if (_selectedOverlay) { _selectedOverlay.setMap(null); _selectedOverlay = null; }
    if (lat === null) return;
    var content = [
      '<div style="',
        'width:22px;height:22px;',
        'background:#1976D2;',
        'border-radius:50%;',
        'border:3px solid #fff;',
        'box-shadow:0 2px 8px rgba(25,118,210,0.6);',
      '"></div>'
    ].join('');
    _selectedOverlay = new kakao.maps.CustomOverlay({
      map: _map, position: new kakao.maps.LatLng(lat, lng),
      content: content, yAnchor: 0.5, xAnchor: 0.5, zIndex: 20
    });
  }

  // 사용자 위치 마커
  function rnSetUserLocation(lat, lng) {
    if (_userMarker) { _userMarker.setMap(null); _userMarker = null; }
    if (lat === null) return;
    var content = '<div style="background:#18181B;color:#fff;font-size:10px;font-weight:700;padding:3px 7px;border-radius:4px;border:1.5px solid #FAFAFA;">내위치</div>';
    _userMarker = new kakao.maps.CustomOverlay({
      map: _map, position: new kakao.maps.LatLng(lat, lng),
      content: content, yAnchor: 0.5, xAnchor: 0.5, zIndex: 15
    });
  }
</script>
<script type="text/javascript"
  src="//dapi.kakao.com/v2/maps/sdk.js?appkey=${apiKey}&autoload=false">
</script>
<script>
  kakao.maps.load(function() { initMap(); });
</script>
</body>
</html>`;
}

const KakaoSkyView = forwardRef<KakaoSkyViewHandle, Props>((props, ref) => {
    const webviewRef = useRef<WebView>(null);

    // 외부에서 지도 이동 명령
    useImperativeHandle(ref, () => ({
        animateToRegion(region: MapRegion) {
            const level = latDeltaToLevel(region.latitudeDelta);
            webviewRef.current?.injectJavaScript(
                `rnMoveTo(${region.latitude}, ${region.longitude}, ${level}); true;`
            );
        },
    }));

    // 마커 동기화
    useEffect(() => {
        if (!props.markers) return;
        const json = JSON.stringify(props.markers);
        webviewRef.current?.injectJavaScript(`rnSetMarkers(${JSON.stringify(json)}); true;`);
    }, [props.markers]);

    // 선택 마커 동기화
    useEffect(() => {
        if (props.selectedMarker) {
            webviewRef.current?.injectJavaScript(
                `rnSetSelectedMarker(${props.selectedMarker.latitude}, ${props.selectedMarker.longitude}); true;`
            );
        } else {
            webviewRef.current?.injectJavaScript(`rnSetSelectedMarker(null, null); true;`);
        }
    }, [props.selectedMarker]);

    // 사용자 위치 동기화
    useEffect(() => {
        if (props.userLocation) {
            webviewRef.current?.injectJavaScript(
                `rnSetUserLocation(${props.userLocation.latitude}, ${props.userLocation.longitude}); true;`
            );
        }
    }, [props.userLocation]);

    // WebView → RN 메시지 처리
    const handleMessage = useCallback((event: WebViewMessageEvent) => {
        try {
            const data = JSON.parse(event.nativeEvent.data);
            switch (data.type) {
                case 'sdkLoaded':
                    props.onLoadProgress?.('sdkLoaded');
                    break;
                case 'mapReady':
                    props.onLoadProgress?.('mapReady');
                    break;
                case 'mapPress':
                    props.onPress?.({ latitude: data.lat, longitude: data.lng });
                    break;
                case 'markerPress':
                    props.onMarkerPress?.(data.id, data.markerType);
                    break;
                case 'regionChange': {
                    const latDelta = levelToLatDelta(data.level);
                    props.onRegionChangeComplete?.({
                        latitude: data.lat,
                        longitude: data.lng,
                        latitudeDelta: latDelta,
                        longitudeDelta: latDelta * 0.8,
                    });
                    break;
                }
            }
        } catch {}
    }, [props.onLoadProgress, props.onPress, props.onMarkerPress, props.onRegionChangeComplete]);

    const html = buildHTML(KAKAO_API_KEY || '', props.initialRegion);

    return (
        <View style={[styles.container, props.style]}>
            <WebView
                ref={webviewRef}
                source={{ html, baseUrl: 'https://dapi.kakao.com' }}
                style={styles.webview}
                originWhitelist={['*']}
                javaScriptEnabled
                domStorageEnabled
                onMessage={handleMessage}
                scrollEnabled={false}
                bounces={false}
                overScrollMode="never"
                showsHorizontalScrollIndicator={false}
                showsVerticalScrollIndicator={false}
                mixedContentMode="always"
            />
        </View>
    );
});

const styles = StyleSheet.create({
    container: { flex: 1 },
    webview: { flex: 1, backgroundColor: '#1a1a2e' },
});

export default KakaoSkyView;
