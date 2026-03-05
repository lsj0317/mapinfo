import React, { forwardRef, useImperativeHandle, useRef, useCallback, useEffect } from 'react';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import type { WebViewErrorEvent } from 'react-native-webview/lib/WebViewTypes';

export interface MapRegion {
    latitude: number;
    longitude: number;
    latitudeDelta: number;
    longitudeDelta: number;
}

export interface MapMarkerItem {
    id: string;
    latitude: number;
    longitude: number;
    type: 'building' | 'property' | 'cluster';
    color?: string;
    title?: string;
    count?: number; // cluster only
}

export interface KakaoMapHandle {
    animateToRegion: (region: MapRegion, duration?: number) => void;
}

interface Props {
    style?: object;
    kakaoApiKey: string;
    vworldApiKey?: string;
    initialRegion: MapRegion;
    onRegionChangeComplete?: (region: MapRegion) => void;
    onPress?: (coordinate: { latitude: number; longitude: number }) => void;
    onMarkerPress?: (id: string, markerType: string) => void;
    mapType?: 'standard' | 'cadastral';
    selectedMarker?: { latitude: number; longitude: number } | null;
    markers?: MapMarkerItem[];
    userLocation?: { latitude: number; longitude: number } | null;
    onReady?: () => void;
    onLoadProgress?: (stage: 'sdkLoaded' | 'mapReady') => void;
}

function latDeltaToLevel(delta: number): number {
    if (delta < 0.001) return 1;
    if (delta < 0.002) return 2;
    if (delta < 0.004) return 3;
    if (delta < 0.008) return 4;
    if (delta < 0.02) return 5;
    if (delta < 0.04) return 6;
    if (delta < 0.08) return 7;
    if (delta < 0.15) return 8;
    if (delta < 0.3) return 9;
    if (delta < 0.6) return 10;
    if (delta < 1.2) return 11;
    if (delta < 2.4) return 12;
    if (delta < 5) return 13;
    return 14;
}

function buildMapHTML(kakaoApiKey: string, initialRegion: MapRegion, vworldApiKey: string): string {
    const initLevel = latDeltaToLevel(initialRegion.latitudeDelta);
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    html,body{width:100%;height:100%;overflow:hidden;}
    #map{position:fixed;top:0;left:0;right:0;bottom:0;}
  </style>
  <script type="text/javascript"
    src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${kakaoApiKey}&autoload=false"
    onerror="window.__kakaoLoadError=true;"></script>
</head>
<body>
  <div id="map"></div>
  <script>
    var map = null;
    var userMarker = null;
    var selectedMarkerObj = null;
    var markerObjects = [];
    var cadastralOverlay = null;

    function latDeltaToLevel(d) {
      if (d < 0.001) return 1;
      if (d < 0.002) return 2;
      if (d < 0.004) return 3;
      if (d < 0.008) return 4;
      if (d < 0.02)  return 5;
      if (d < 0.04)  return 6;
      if (d < 0.08)  return 7;
      if (d < 0.15)  return 8;
      if (d < 0.3)   return 9;
      if (d < 0.6)   return 10;
      if (d < 1.2)   return 11;
      if (d < 2.4)   return 12;
      if (d < 5)     return 13;
      return 14;
    }

    function levelToLatDelta(l) {
      var t = [0.0005,0.0015,0.003,0.006,0.015,0.03,0.06,0.12,0.25,0.5,1.0,2.0,4.0,8.0];
      return t[Math.min(Math.max(l-1,0), t.length-1)];
    }

    function send(data) {
      try { window.ReactNativeWebView.postMessage(JSON.stringify(data)); } catch(e) {}
    }

    // 콘솔 캡처 → RN으로 전달
    window.onerror = function(msg, src, line) {
      send({ type: 'jsError', message: String(msg), source: String(src), line: line });
    };
    ['log','warn','error'].forEach(function(t) {
      var orig = console[t].bind(console);
      console[t] = function() {
        var msg = Array.prototype.slice.call(arguments).join(' ');
        send({ type: 'console', level: t, message: msg });
        orig.apply(console, arguments);
      };
    });
    send({ type: 'pageLoaded', kakaoExists: typeof kakao !== 'undefined', loadError: !!window.__kakaoLoadError });

    function svgToDataUrl(svg, w, h) {
      try {
        return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
      } catch(e) {
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      }
    }

    function makeMarkerImage(svg, w, h, ox, oy) {
      return new kakao.maps.MarkerImage(
        svgToDataUrl(svg, w, h),
        new kakao.maps.Size(w, h),
        { offset: new kakao.maps.Point(ox, oy) }
      );
    }

    function pinSvg(color) {
      return '<svg width="30" height="42" xmlns="http://www.w3.org/2000/svg">'
        + '<path d="M15 0C6.7 0 0 6.7 0 15c0 9.4 15 27 15 27s15-17.6 15-27C30 6.7 23.3 0 15 0z" fill="' + color + '"/>'
        + '<circle cx="15" cy="15" r="7" fill="white"/>'
        + '</svg>';
    }

    function clusterSvg(count, color) {
      var s = count >= 10 ? 54 : count >= 5 ? 46 : 38;
      var r1 = s / 2 - 1;
      var r2 = s / 2 - 5;
      var fs = count >= 10 ? 14 : 13;
      return '<svg width="' + s + '" height="' + s + '" xmlns="http://www.w3.org/2000/svg">'
        + '<circle cx="' + (s/2) + '" cy="' + (s/2) + '" r="' + r1 + '" fill="white" stroke="' + color + '" stroke-width="2"/>'
        + '<circle cx="' + (s/2) + '" cy="' + (s/2) + '" r="' + r2 + '" fill="' + color + '"/>'
        + '<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="white" font-size="' + fs + '" font-family="sans-serif">' + count + '</text>'
        + '</svg>';
    }

    function selectedPinSvg() {
      return '<svg width="32" height="44" xmlns="http://www.w3.org/2000/svg">'
        + '<path d="M16 0C7.2 0 0 7.2 0 16c0 10 16 28 16 28s16-18 16-28C32 7.2 24.8 0 16 0z" fill="#1976D2"/>'
        + '<circle cx="16" cy="16" r="8" fill="white"/>'
        + '</svg>';
    }

    function userDotSvg() {
      return '<svg width="52" height="24" xmlns="http://www.w3.org/2000/svg">'
        + '<rect x="0" y="0" width="52" height="24" rx="6" fill="#18181B" stroke="#FAFAFA" stroke-width="1.5"/>'
        + '<text x="26" y="16" text-anchor="middle" fill="#FAFAFA" font-size="11" font-family="sans-serif" font-weight="600">내위치</text>'
        + '</svg>';
    }

    // ===== Global RN Commands =====

    window.rnMoveTo = function(lat, lng, level) {
      if (!map) return;
      map.setLevel(level);
      map.panTo(new kakao.maps.LatLng(lat, lng));
    };

    window.rnSetMapType = function(type) {
      if (!map || !cadastralOverlay) return;
      if (type === 'cadastral') {
        cadastralOverlay.setMap(map);
      } else {
        cadastralOverlay.setMap(null);
      }
    };

    window.rnSetMarkers = function(markerList) {
      markerObjects.forEach(function(m) { m.setMap(null); });
      markerObjects = [];
      (markerList || []).forEach(function(m) {
        var marker;
        if (m.type === 'cluster') {
          var s = m.count >= 10 ? 54 : m.count >= 5 ? 46 : 38;
          var svg = clusterSvg(m.count, m.color || '#9E9E9E');
          var img = makeMarkerImage(svg, s, s, s/2, s/2);
          marker = new kakao.maps.Marker({
            position: new kakao.maps.LatLng(m.latitude, m.longitude),
            image: img,
            map: map
          });
        } else {
          var svg2 = pinSvg(m.color || '#FF5722');
          var img2 = makeMarkerImage(svg2, 30, 42, 15, 42);
          marker = new kakao.maps.Marker({
            position: new kakao.maps.LatLng(m.latitude, m.longitude),
            image: img2,
            map: map,
            title: m.title || ''
          });
        }
        (function(markerId, markerType) {
          kakao.maps.event.addListener(marker, 'click', function() {
            send({ type: 'markerPress', id: markerId, markerType: markerType });
          });
        })(m.id, m.type);
        markerObjects.push(marker);
      });
    };

    window.rnSetSelected = function(lat, lng) {
      if (selectedMarkerObj) { selectedMarkerObj.setMap(null); selectedMarkerObj = null; }
      if (lat != null && lng != null) {
        var img = makeMarkerImage(selectedPinSvg(), 32, 44, 16, 44);
        selectedMarkerObj = new kakao.maps.Marker({
          position: new kakao.maps.LatLng(lat, lng),
          image: img,
          map: map
        });
      }
    };

    window.rnSetUserLocation = function(lat, lng) {
      if (userMarker) { userMarker.setMap(null); userMarker = null; }
      if (lat != null && lng != null) {
        var img = makeMarkerImage(userDotSvg(), 52, 24, 26, 12);
        userMarker = new kakao.maps.Marker({
          position: new kakao.maps.LatLng(lat, lng),
          image: img,
          map: map
        });
      }
    };

    // ===== Map Init =====

    function init() {
      try {
        var container = document.getElementById('map');
        var options = {
          center: new kakao.maps.LatLng(${initialRegion.latitude}, ${initialRegion.longitude}),
          level: ${initLevel}
        };
        map = new kakao.maps.Map(container, options);

        // VWorld WMS 지적도 커스텀 타일셋
        try {
          var tileset = new kakao.maps.Tileset(256, 256, function(x, y, z) {
            var half = 20037508.34;
            var sz = half * 2 / Math.pow(2, z);
            var minX = x * sz - half;
            var maxX = minX + sz;
            var maxY = half - y * sz;
            var minY = maxY - sz;
            var bbox = minX + ',' + minY + ',' + maxX + ',' + maxY;
            return 'https://api.vworld.kr/req/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&FORMAT=image/png&TRANSPARENT=true&LAYERS=lp_pa_cbnd_bonbun,lp_pa_cbnd_bubun&STYLES=,&CRS=EPSG:900913&BBOX=' + bbox + '&WIDTH=256&HEIGHT=256&key=${vworldApiKey}';
          }, 14, 19, false);
          kakao.maps.Tileset.add('VWORLD_CAD', tileset);
          cadastralOverlay = new kakao.maps.TileOverlay(['VWORLD_CAD'], 2, 0.75);
        } catch(te) { cadastralOverlay = null; }

        // 지도 이동 완료 이벤트
        kakao.maps.event.addListener(map, 'idle', function() {
          var c = map.getCenter();
          var b = map.getBounds();
          var sw = b.getSouthWest();
          var ne = b.getNorthEast();
          send({
            type: 'regionChange',
            latitude: c.getLat(),
            longitude: c.getLng(),
            latitudeDelta: ne.getLat() - sw.getLat(),
            longitudeDelta: ne.getLng() - sw.getLng()
          });
        });

        // 지도 클릭 이벤트
        kakao.maps.event.addListener(map, 'click', function(e) {
          var ll = e.latLng;
          send({ type: 'mapPress', latitude: ll.getLat(), longitude: ll.getLng() });
        });

        send({ type: 'ready' });
      } catch(err) {
        send({ type: 'error', message: err.message });
      }
    }

    // Android WebView: document message event
    document.addEventListener('message', function(e) {
      try {
        var d = JSON.parse(e.data);
        if (d && d.cmd) {
          if (d.cmd === 'moveTo')       window.rnMoveTo(d.lat, d.lng, d.level);
          else if (d.cmd === 'mapType') window.rnSetMapType(d.value);
          else if (d.cmd === 'markers') window.rnSetMarkers(d.markers);
          else if (d.cmd === 'selected') window.rnSetSelected(d.lat, d.lng);
          else if (d.cmd === 'userLoc') window.rnSetUserLocation(d.lat, d.lng);
        }
      } catch(e) {}
    });

    // iOS WebView: window message event
    window.addEventListener('message', function(e) {
      try {
        var d = JSON.parse(e.data);
        if (d && d.cmd) {
          if (d.cmd === 'moveTo')       window.rnMoveTo(d.lat, d.lng, d.level);
          else if (d.cmd === 'mapType') window.rnSetMapType(d.value);
          else if (d.cmd === 'markers') window.rnSetMarkers(d.markers);
          else if (d.cmd === 'selected') window.rnSetSelected(d.lat, d.lng);
          else if (d.cmd === 'userLoc') window.rnSetUserLocation(d.lat, d.lng);
        }
      } catch(e) {}
    });

    if (window.__kakaoLoadError) {
      send({ type: 'error', message: 'Kakao SDK script failed to load (onerror). Check API key and Kakao developer console web platform settings.' });
    } else if (typeof kakao !== 'undefined' && kakao.maps) {
      kakao.maps.load(init);
    } else {
      // autoload=false 이므로 DOMContentLoaded 후에 수동 로드
      document.addEventListener('DOMContentLoaded', function() {
        if (window.__kakaoLoadError) {
          send({ type: 'error', message: 'Kakao SDK failed (DOMContentLoaded). API key: ${kakaoApiKey.slice(0,8)}...' });
        } else if (typeof kakao !== 'undefined' && kakao.maps) {
          kakao.maps.load(init);
        } else {
          send({ type: 'error', message: 'kakao undefined after DOMContentLoaded. SDK not loaded.' });
        }
      });
      // 이미 로드된 경우 대비
      if (document.readyState !== 'loading') {
        if (typeof kakao !== 'undefined' && kakao.maps) kakao.maps.load(init);
        else if (!window.__kakaoLoadError) send({ type: 'error', message: 'kakao undefined, readyState: ' + document.readyState });
      }
    }
  </script>
</body>
</html>`;
}

const KakaoMapView = forwardRef<KakaoMapHandle, Props>((props, ref) => {
    const webViewRef = useRef<WebView>(null);
    const isReady = useRef(false);
    const pendingCmds = useRef<string[]>([]);

    const inject = useCallback((js: string) => {
        const code = js + '; true;';
        if (isReady.current) {
            webViewRef.current?.injectJavaScript(code);
        } else {
            pendingCmds.current.push(code);
        }
    }, []);

    useImperativeHandle(ref, () => ({
        animateToRegion(region: MapRegion) {
            const level = latDeltaToLevel(region.latitudeDelta);
            inject(`window.rnMoveTo(${region.latitude}, ${region.longitude}, ${level});`);
        },
    }));

    const onMessage = useCallback((event: WebViewMessageEvent) => {
        try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data.type === 'ready') {
                console.log('[KakaoMap] Map ready!');
                isReady.current = true;
                pendingCmds.current.forEach(cmd => webViewRef.current?.injectJavaScript(cmd));
                pendingCmds.current = [];
                props.onLoadProgress?.('mapReady');
                props.onReady?.();
            } else if (data.type === 'regionChange') {
                props.onRegionChangeComplete?.({
                    latitude: data.latitude,
                    longitude: data.longitude,
                    latitudeDelta: data.latitudeDelta,
                    longitudeDelta: data.longitudeDelta,
                });
            } else if (data.type === 'mapPress') {
                props.onPress?.({ latitude: data.latitude, longitude: data.longitude });
            } else if (data.type === 'markerPress') {
                props.onMarkerPress?.(data.id, data.markerType);
            } else if (data.type === 'pageLoaded') {
                console.log('[KakaoMap] pageLoaded kakaoExists:', data.kakaoExists, 'loadError:', data.loadError);
                if (data.kakaoExists && !data.loadError) props.onLoadProgress?.('sdkLoaded');
            } else if (data.type === 'error') {
                console.error('[KakaoMap] ERROR:', data.message);
            } else if (data.type === 'console') {
                console.log(`[KakaoMap WebView ${data.level}]`, data.message);
            } else if (data.type === 'jsError') {
                console.warn('[KakaoMap JS Error]', data.message, 'at', data.source, 'line', data.line);
            }
        } catch (_) {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const onWebViewError = useCallback((e: WebViewErrorEvent) => {
        console.warn('[KakaoMap] WebView error:', e.nativeEvent.description, e.nativeEvent.url);
    }, []);

    const onHttpError = useCallback((e: any) => {
        console.warn('[KakaoMap] HTTP error:', e.nativeEvent.statusCode, e.nativeEvent.url);
    }, []);

    useEffect(() => {
        inject(`window.rnSetMapType('${props.mapType || 'standard'}');`);
    }, [props.mapType, inject]);

    useEffect(() => {
        const json = JSON.stringify(props.markers || []);
        inject(`window.rnSetMarkers(${json});`);
    }, [props.markers, inject]);

    useEffect(() => {
        if (props.selectedMarker) {
            inject(`window.rnSetSelected(${props.selectedMarker.latitude}, ${props.selectedMarker.longitude});`);
        } else {
            inject(`window.rnSetSelected(null, null);`);
        }
    }, [props.selectedMarker, inject]);

    useEffect(() => {
        if (props.userLocation) {
            inject(`window.rnSetUserLocation(${props.userLocation.latitude}, ${props.userLocation.longitude});`);
        }
    }, [props.userLocation, inject]);

    // initialRegion은 최초 마운트 시 1회만 사용 → props 변경 시 WebView 재로드 방지
    const htmlRef = useRef(buildMapHTML(
        props.kakaoApiKey,
        props.initialRegion,
        props.vworldApiKey || '',
    ));

    return (
        <WebView
            ref={webViewRef}
            source={{ html: htmlRef.current, baseUrl: 'http://localhost' }}
            style={[{ flex: 1 }, props.style]}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            originWhitelist={['*']}
            mixedContentMode="always"
            onMessage={onMessage}
            onError={onWebViewError}
            onHttpError={onHttpError}
            startInLoadingState={false}
            scrollEnabled={false}
        />
    );
});

export default KakaoMapView;