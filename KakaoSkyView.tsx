/**
 * KakaoSkyView.tsx
 * 카카오 스카이뷰(항공사진) 전용 지도 컴포넌트
 * - Kakao Maps JS SDK WebView 기반
 * - VWorld 지적도 경계선 오버레이 (항상 표시)
 * - 마커 클릭 시 말풍선 표시
 * - 사용자 위치 나침반(동서남북 + 방향 화살표)
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
    subtitle?: string;
    count?: number;
}

interface Props {
    style?: object;
    vworldApiKey?: string;
    initialRegion: MapRegion;
    onRegionChangeComplete?: (region: MapRegion) => void;
    onPress?: (coordinate: { latitude: number; longitude: number }) => void;
    onMarkerPress?: (id: string, markerType: string) => void;
    markers?: SkyMarkerItem[];
    selectedMarker?: { latitude: number; longitude: number; title?: string; subtitle?: string } | null;
    userLocation?: { latitude: number; longitude: number } | null;
    heading?: number | null;
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

function buildHTML(apiKey: string, vworldApiKey: string, region: MapRegion): string {
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
  .sky-bubble {
    position: relative;
    background: #fff;
    border-radius: 10px;
    padding: 8px 12px;
    box-shadow: 0 3px 12px rgba(0,0,0,0.28);
    max-width: 200px;
    min-width: 100px;
    font-family: -apple-system, sans-serif;
    cursor: pointer;
  }
  .sky-bubble::after {
    content: '';
    position: absolute;
    bottom: -8px;
    left: 50%;
    transform: translateX(-50%);
    width: 0; height: 0;
    border-left: 8px solid transparent;
    border-right: 8px solid transparent;
    border-top: 8px solid #fff;
  }
  .sky-bubble-title {
    font-size: 13px;
    font-weight: 700;
    color: #111;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 176px;
  }
  .sky-bubble-subtitle {
    font-size: 11px;
    color: #666;
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 176px;
  }
  /* 나침반 컨테이너 */
  .compass-wrap {
    position: relative;
    width: 76px; height: 76px;
    display: flex; align-items: center; justify-content: center;
    cursor: default;
  }
  .compass-ring {
    position: absolute;
    width: 60px; height: 60px;
    border-radius: 50%;
    border: 1.5px solid rgba(25,118,210,0.45);
    background: rgba(25,118,210,0.07);
  }
  .compass-label {
    position: absolute;
    font-size: 9px; font-weight: 700;
    font-family: -apple-system, sans-serif;
    width: 14px; text-align: center;
  }
  .compass-north { color:#D32F2F; top:2px; left:31px; }
  .compass-south { color:#1976D2; bottom:2px; left:31px; }
  .compass-west  { color:#1976D2; left:2px; top:31px; }
  .compass-east  { color:#1976D2; right:2px; top:31px; }
  .compass-arrow-wrap {
    position: absolute;
    width: 76px; height: 76px;
    display: flex; align-items: flex-start; justify-content: center;
    pointer-events: none;
  }
  .compass-arrow {
    margin-top: 8px;
    width: 0; height: 0;
    border-left: 5px solid transparent;
    border-right: 5px solid transparent;
    border-bottom: 15px solid #1976D2;
  }
  .compass-dot {
    width: 14px; height: 14px;
    border-radius: 50%;
    background: #1976D2;
    border: 2px solid #fff;
    position: relative; z-index: 1;
  }
</style>
</head>
<body>
<div id="map"></div>
<script>
  var _markers = {};
  var _markerData = {};
  var _selectedOverlay = null;
  var _userMarker = null;
  var _infoBubble = null;
  var _map = null;
  var _ready = false;

  function postRN(obj) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(obj)); } catch(e) {}
  }

  // 말풍선 표시
  function showBubble(lat, lng, title, subtitle) {
    hideBubble();
    if (!title && !subtitle) return;
    var inner = '<div class="sky-bubble">'
      + '<div class="sky-bubble-title">' + (title || '') + '</div>'
      + (subtitle ? '<div class="sky-bubble-subtitle">' + subtitle + '</div>' : '')
      + '</div>';
    _infoBubble = new kakao.maps.CustomOverlay({
      map: _map,
      position: new kakao.maps.LatLng(lat, lng),
      content: inner,
      yAnchor: 1.45,
      xAnchor: 0.5,
      zIndex: 30
    });
  }

  // 말풍선 숨기기
  function hideBubble() {
    if (_infoBubble) { _infoBubble.setMap(null); _infoBubble = null; }
  }

  // 마커 클릭 핸들러 (전역 - HTML onclick에서 호출)
  window.rnMarkerClick = function(id) {
    var d = _markerData[id];
    if (d) {
      showBubble(d.lat, d.lng, d.title, d.subtitle);
      postRN({ type: 'markerPress', id: id, markerType: d.markerType || '' });
    }
  };

  function initMap() {
    var container = document.getElementById('map');
    var options = {
      center: new kakao.maps.LatLng(${lat}, ${lng}),
      level: ${level},
      mapTypeId: kakao.maps.MapTypeId.HYBRID
    };
    _map = new kakao.maps.Map(container, options);

    // VWorld 지적도 WMS 오버레이
    var vwKey = '${vworldApiKey}';
    if (vwKey) {
      try {
        var tileset = new kakao.maps.Tileset(256, 256, function(x, y, z) {
          var half = 20037508.34;
          var sz = half * 2 / Math.pow(2, z);
          var minX = x * sz - half;
          var maxX = minX + sz;
          var maxY = half - y * sz;
          var minY = maxY - sz;
          var bbox = minX + ',' + minY + ',' + maxX + ',' + maxY;
          return 'https://api.vworld.kr/req/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&FORMAT=image/png&TRANSPARENT=true&LAYERS=lp_pa_cbnd_bonbun,lp_pa_cbnd_bubun&STYLES=,&CRS=EPSG:900913&BBOX=' + bbox + '&WIDTH=256&HEIGHT=256&key=' + vwKey;
        }, 14, 19, false);
        kakao.maps.Tileset.add('VWORLD_CAD', tileset);
        var cadOverlay = new kakao.maps.TileOverlay(['VWORLD_CAD'], 2, 0.75);
        cadOverlay.setMap(_map);
      } catch(e) {}
    }

    _ready = true;
    postRN({ type: 'sdkLoaded' });
    postRN({ type: 'mapReady' });

    // 지도 클릭 → 말풍선 닫기
    kakao.maps.event.addListener(_map, 'click', function(mouseEvent) {
      hideBubble();
      var latlng = mouseEvent.latLng;
      postRN({ type: 'mapPress', lat: latlng.getLat(), lng: latlng.getLng() });
    });

    // 지도 이동 완료
    kakao.maps.event.addListener(_map, 'idle', function() {
      var center = _map.getCenter();
      var level = _map.getLevel();
      postRN({ type: 'regionChange', lat: center.getLat(), lng: center.getLng(), level: level });
    });
  }

  // 마커 설정 (전체 교체)
  function rnSetMarkers(jsonStr) {
    if (!_map || !_ready) return;
    var items = JSON.parse(jsonStr);

    Object.values(_markers).forEach(function(m) { m.setMap(null); });
    _markers = {};
    _markerData = {};

    items.forEach(function(item) {
      var pos = new kakao.maps.LatLng(item.latitude, item.longitude);
      var color = item.color || '#FF5722';
      var size = item.type === 'cluster' ? 36 : 28;
      var label = item.type === 'cluster' ? (item.count || '') : '';
      var id = item.id;

      // 마커 데이터 저장
      _markerData[id] = {
        lat: item.latitude, lng: item.longitude,
        title: item.title || '', subtitle: item.subtitle || '',
        markerType: item.type || ''
      };

      // onclick에 rnMarkerClick 직접 호출 (CustomOverlay string content용)
      var safeId = id.replace(/'/g, "\\'");
      var content = '<div onclick="rnMarkerClick(\'' + safeId + '\')" style="'
        + 'width:' + size + 'px;height:' + size + 'px;'
        + 'background:' + color + ';'
        + 'border-radius:50%;'
        + 'border:2.5px solid #fff;'
        + 'box-shadow:0 2px 6px rgba(0,0,0,0.45);'
        + 'display:flex;align-items:center;justify-content:center;'
        + 'cursor:pointer;'
        + 'font-size:11px;font-weight:700;color:#fff;'
        + '">' + label + '</div>';

      var overlay = new kakao.maps.CustomOverlay({
        map: _map, position: pos, content: content,
        yAnchor: 0.5, xAnchor: 0.5, zIndex: 10
      });

      _markers[id] = overlay;
    });
  }

  // 지도 이동
  function rnMoveTo(lat, lng, level) {
    if (!_map || !_ready) return;
    _map.setCenter(new kakao.maps.LatLng(lat, lng));
    if (level) _map.setLevel(level, { animate: true });
  }

  // 선택 마커 (파란 핀 + 말풍선)
  function rnSetSelectedMarker(lat, lng, title, subtitle) {
    if (_selectedOverlay) { _selectedOverlay.setMap(null); _selectedOverlay = null; }
    hideBubble();
    if (lat === null) return;

    var content = '<div style="'
      + 'width:0;height:0;'
      + 'border-left:9px solid transparent;'
      + 'border-right:9px solid transparent;'
      + 'border-top:18px solid #1976D2;'
      + 'filter:drop-shadow(0 2px 4px rgba(25,118,210,0.5));'
      + '"></div>';
    _selectedOverlay = new kakao.maps.CustomOverlay({
      map: _map, position: new kakao.maps.LatLng(lat, lng),
      content: content, yAnchor: 1.0, xAnchor: 0.5, zIndex: 20
    });

    if (title || subtitle) showBubble(lat, lng, title, subtitle);
  }

  // 사용자 위치 나침반 마커 (동서남북 + 방향 화살표)
  function rnSetUserLocation(lat, lng, heading) {
    if (_userMarker) { _userMarker.setMap(null); _userMarker = null; }
    if (lat === null) return;

    var hasHeading = (heading !== null && heading !== undefined && heading >= 0);
    var arrowHtml = hasHeading
      ? '<div class="compass-arrow-wrap" style="transform:rotate(' + heading + 'deg);">'
        + '<div class="compass-arrow"></div>'
        + '</div>'
      : '';

    var content = '<div class="compass-wrap">'
      + '<div class="compass-ring"></div>'
      + '<span class="compass-label compass-north">북</span>'
      + '<span class="compass-label compass-south">남</span>'
      + '<span class="compass-label compass-west">서</span>'
      + '<span class="compass-label compass-east">동</span>'
      + arrowHtml
      + '<div class="compass-dot"></div>'
      + '</div>';

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

    // 선택 마커 + 말풍선 동기화
    useEffect(() => {
        if (props.selectedMarker) {
            const t = JSON.stringify(props.selectedMarker.title || '');
            const s = JSON.stringify(props.selectedMarker.subtitle || '');
            webviewRef.current?.injectJavaScript(
                `rnSetSelectedMarker(${props.selectedMarker.latitude}, ${props.selectedMarker.longitude}, ${t}, ${s}); true;`
            );
        } else {
            webviewRef.current?.injectJavaScript(`rnSetSelectedMarker(null, null, null, null); true;`);
        }
    }, [props.selectedMarker]);

    // 사용자 위치 + heading 동기화
    useEffect(() => {
        if (props.userLocation) {
            const h = (props.heading !== null && props.heading !== undefined && props.heading >= 0)
                ? props.heading
                : 'null';
            webviewRef.current?.injectJavaScript(
                `rnSetUserLocation(${props.userLocation.latitude}, ${props.userLocation.longitude}, ${h}); true;`
            );
        }
    }, [props.userLocation, props.heading]);

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

    const html = buildHTML(KAKAO_API_KEY || '', props.vworldApiKey || '', props.initialRegion);

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
