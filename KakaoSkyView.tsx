/**
 * KakaoSkyView.tsx
 * 카카오 스카이뷰(항공사진) 전용 지도 컴포넌트
 * - Kakao Maps JS SDK WebView 기반
 * - 한국 최신 항공사진 (구글 대비 갱신 주기 짧음)
 * - 마커, 위치 이동, 클릭 이벤트 지원
 */
import React, { forwardRef, useImperativeHandle, useRef, useCallback, useEffect, useMemo } from 'react';
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
    initialRegion: MapRegion;
    onRegionChangeComplete?: (region: MapRegion) => void;
    onPress?: (coordinate: { latitude: number; longitude: number }) => void;
    onMarkerPress?: (id: string, markerType: string) => void;
    markers?: SkyMarkerItem[];
    selectedMarker?: { latitude: number; longitude: number; title?: string; subtitle?: string } | null;
    userLocation?: { latitude: number; longitude: number } | null;
    heading?: number | null;
    onLoadProgress?: (stage: 'sdkLoaded' | 'mapReady') => void;
    // 호환성을 위해 선언만 (미사용)
    vworldApiKey?: string;
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
  var SQ = String.fromCharCode(39);
  var _ready = false;

  function postRN(obj) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(obj)); } catch(e) {}
  }

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

  function hideBubble() {
    if (_infoBubble) { _infoBubble.setMap(null); _infoBubble = null; }
  }

  window.rnMarkerClick = function(id) {
    var d = _markerData[id];
    if (d) {
      showBubble(d.lat, d.lng, d.title, d.subtitle);
      postRN({ type: 'markerPress', id: id, markerType: d.markerType || '' });
    }
  };

  function initMap() {
    try {
      var container = document.getElementById('map');
      var options = {
        center: new kakao.maps.LatLng(${lat}, ${lng}),
        level: ${level}
      };
      _map = new kakao.maps.Map(container, options);
      _map.setMapTypeId(kakao.maps.MapTypeId.HYBRID);
      _ready = true;

      postRN({ type: 'sdkLoaded' });
      postRN({ type: 'mapReady' });

      kakao.maps.event.addListener(_map, 'click', function(mouseEvent) {
        hideBubble();
        var latlng = mouseEvent.latLng;
        postRN({ type: 'mapPress', lat: latlng.getLat(), lng: latlng.getLng() });
      });

      kakao.maps.event.addListener(_map, 'idle', function() {
        var center = _map.getCenter();
        var level = _map.getLevel();
        postRN({ type: 'regionChange', lat: center.getLat(), lng: center.getLng(), level: level });
      });
    } catch(e) {
      var msg = (e && e.message) ? e.message : String(e);
      postRN({ type: 'initError', message: msg });
      var errDiv = document.createElement('div');
      errDiv.style.cssText = 'position:fixed;top:10px;left:10px;right:10px;background:rgba(200,0,0,0.9);color:#fff;padding:12px;z-index:9999;font-size:13px;border-radius:8px;word-break:break-all;';
      errDiv.textContent = 'KakaoMap Error: ' + msg;
      document.body.appendChild(errDiv);
    }
  }

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

      _markerData[id] = {
        lat: item.latitude, lng: item.longitude,
        title: item.title || '', subtitle: item.subtitle || '',
        markerType: item.type || ''
      };

      var safeId = id.replace(/'/g, "&#39;");
      var content = '<div onclick="rnMarkerClick(' + SQ + safeId + SQ + ')" style="'
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

  function rnMoveTo(lat, lng, level) {
    if (!_map || !_ready) return;
    _map.setCenter(new kakao.maps.LatLng(lat, lng));
    if (level) _map.setLevel(level, { animate: true });
  }

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

  function rnSetUserLocation(lat, lng) {
    if (!_map || !_ready) return;
    if (_userMarker) { _userMarker.setMap(null); _userMarker = null; }
    if (lat === null) return;
    var content = '<div style="'
      + 'width:20px;height:20px;'
      + 'border-radius:50%;'
      + 'background:#4285F4;'
      + 'border:3px solid #fff;'
      + 'box-shadow:0 2px 6px rgba(66,133,244,0.6);'
      + '"></div>';
    _userMarker = new kakao.maps.CustomOverlay({
      map: _map, position: new kakao.maps.LatLng(lat, lng),
      content: content, yAnchor: 0.5, xAnchor: 0.5, zIndex: 15
    });
  }

  function showErr(msg) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;top:10px;left:10px;right:10px;background:rgba(200,0,0,0.92);color:#fff;padding:12px;z-index:9999;font-size:12px;border-radius:8px;word-break:break-all;';
    d.textContent = msg;
    document.body.appendChild(d);
    postRN({ type: 'initError', message: msg });
  }

  postRN({ type: 'log', message: 'HTML 파싱 완료. kakao.maps.load() 호출 대기중...' });

  // SDK 로딩 타임아웃: 15초
  setTimeout(function() {
    if (!_ready) {
      var msg = 'SDK timeout(15s). onLine=' + navigator.onLine;
      showErr(msg);
      postRN({ type: 'sdkTimeout', message: msg, onLine: navigator.onLine });
    }
  }, 15000);
</script>
<script src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${apiKey}&autoload=false"
  onerror="var m='SDK script FAILED. online='+navigator.onLine; showErr(m); postRN({type:'sdkScriptError',message:m});"></script>
<script>
  kakao.maps.load(function() {
    postRN({ type: 'log', message: 'kakao.maps.load() 완료. initMap 호출...' });
    initMap();
  });
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

    // 사용자 위치 동기화
    useEffect(() => {
        if (props.userLocation) {
            webviewRef.current?.injectJavaScript(
                `rnSetUserLocation(${props.userLocation.latitude}, ${props.userLocation.longitude}); true;`
            );
        }
    }, [props.userLocation]);

    const handleMessage = useCallback((event: WebViewMessageEvent) => {
        try {
            const data = JSON.parse(event.nativeEvent.data);
            switch (data.type) {
                case 'sdkLoaded':
                    console.log('[KakaoSkyView] ✅ SDK 로드 완료');
                    props.onLoadProgress?.('sdkLoaded');
                    break;
                case 'mapReady':
                    console.log('[KakaoSkyView] ✅ 지도 초기화 완료 (mapReady)');
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
                case 'initError':
                    console.error('[KakaoSkyView] ❌ initMap 오류:', data.message);
                    break;
                case 'sdkScriptError':
                    console.error('[KakaoSkyView] ❌ SDK 스크립트 로드 실패:', data.message);
                    break;
                case 'sdkTimeout':
                    console.error('[KakaoSkyView] ❌ SDK 로드 타임아웃 (10s). onLine:', data.onLine, '| apiKeyPrefix:', data.apiKeyPrefix);
                    break;
                case 'log':
                    console.log('[KakaoSkyView][WebView]', data.message);
                    break;
            }
        } catch (e) {
            console.error('[KakaoSkyView] handleMessage 파싱 오류:', e);
        }
    }, [props.onLoadProgress, props.onPress, props.onMarkerPress, props.onRegionChangeComplete]);

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const source = useMemo(() => ({
        html: buildHTML(KAKAO_API_KEY || '', props.initialRegion),
        baseUrl: 'https://dapi.kakao.com',
    }), []);

    return (
        <View style={[styles.container, props.style]}>
            <WebView
                ref={webviewRef}
                source={source}
                style={styles.webview}
                originWhitelist={['*']}
                javaScriptEnabled
                domStorageEnabled
                onMessage={handleMessage}
                onError={(e) => console.error('[KakaoSkyView] WebView error:', e.nativeEvent)}
                onHttpError={(e) => console.error('[KakaoSkyView] HTTP error:', e.nativeEvent.statusCode)}
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
    webview: { flex: 1, backgroundColor: 'transparent' },
});

export default KakaoSkyView;
