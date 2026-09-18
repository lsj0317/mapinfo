import React, { forwardRef, useImperativeHandle, useRef, useState, useEffect } from 'react';
import { View, Text, Animated, Easing } from 'react-native';
import MapView, { Marker, WMSTile, PROVIDER_GOOGLE } from 'react-native-maps';

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
    count?: number;
}

export interface GoogleMapHandle {
    animateToRegion: (region: MapRegion, duration?: number) => void;
}

interface Props {
    style?: object;
    vworldApiKey?: string;
    initialRegion: MapRegion;
    onRegionChangeComplete?: (region: MapRegion) => void;
    onPress?: (coordinate: { latitude: number; longitude: number }) => void;
    onMarkerPress?: (id: string, markerType: string) => void;
    mapType?: 'standard' | 'cadastral';
    selectedMarker?: { latitude: number; longitude: number } | null;
    markers?: MapMarkerItem[];
    userLocation?: { latitude: number; longitude: number } | null;
    heading?: number | null;
    onReady?: () => void;
    onLoadProgress?: (stage: 'sdkLoaded' | 'mapReady') => void;
}

// latitudeDelta < 0.04 ≈ zoom 14+ (지적도 표시 기준)
const CADASTRAL_MIN_LAT_DELTA = 0.04;

// 사용자 위치 나침반 마커
const CompassMarker = ({ heading }: { heading: number | null }) => {
    const hasHeading = heading !== null && heading !== undefined && heading >= 0;
    // 부드러운 회전을 위한 내부 Animated.Value
    const animRotation = useRef(new Animated.Value(0)).current;
    const currentRotRef = useRef(0);

    useEffect(() => {
        if (!hasHeading || heading === null) return;
        // 최단경로 회전 계산
        let diff = heading - currentRotRef.current;
        if (diff > 180) diff -= 360;
        if (diff < -180) diff += 360;
        const next = currentRotRef.current + diff;
        currentRotRef.current = next;
        Animated.timing(animRotation, {
            toValue: next,
            duration: 350,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
        }).start();
    }, [heading]);

    return (
        <View style={{ width: 76, height: 76, alignItems: 'center', justifyContent: 'center' }}>
            {/* 바깥 링 */}
            <View style={{
                position: 'absolute',
                width: 60, height: 60,
                borderRadius: 30,
                borderWidth: 1.5,
                borderColor: 'rgba(25,118,210,0.45)',
                backgroundColor: 'rgba(25,118,210,0.07)',
            }} />
            {/* 북 */}
            <Text style={{ position: 'absolute', top: 2, left: '50%', marginLeft: -7, fontSize: 9, fontWeight: '800', color: '#D32F2F', width: 14, textAlign: 'center' }}>북</Text>
            {/* 남 */}
            <Text style={{ position: 'absolute', bottom: 2, left: '50%', marginLeft: -7, fontSize: 9, fontWeight: '700', color: '#1976D2', width: 14, textAlign: 'center' }}>남</Text>
            {/* 서 */}
            <Text style={{ position: 'absolute', left: 2, top: '50%', marginTop: -7, fontSize: 9, fontWeight: '700', color: '#1976D2', width: 14, textAlign: 'center' }}>서</Text>
            {/* 동 */}
            <Text style={{ position: 'absolute', right: 2, top: '50%', marginTop: -7, fontSize: 9, fontWeight: '700', color: '#1976D2', width: 14, textAlign: 'center' }}>동</Text>
            {/* 방향 화살표 (부드러운 Animated 회전) */}
            {hasHeading && (
                <Animated.View style={{
                    position: 'absolute',
                    width: 76, height: 76,
                    alignItems: 'center',
                    justifyContent: 'flex-start',
                    transform: [{ rotate: animRotation.interpolate({ inputRange: [-7200, 7200], outputRange: ['-7200deg', '7200deg'] }) }],
                }}>
                    <View style={{
                        marginTop: 8,
                        width: 0, height: 0,
                        borderLeftWidth: 5, borderRightWidth: 5, borderBottomWidth: 15,
                        borderLeftColor: 'transparent', borderRightColor: 'transparent',
                        borderBottomColor: '#1976D2',
                    }} />
                </Animated.View>
            )}
            {/* 중심 원점 */}
            <View style={{
                width: 14, height: 14, borderRadius: 7,
                backgroundColor: '#1976D2',
                borderWidth: 2, borderColor: '#fff',
            }} />
        </View>
    );
};

const GoogleMapView = forwardRef<GoogleMapHandle, Props>((props, ref) => {
    const mapRef = useRef<MapView>(null);
    const [latDelta, setLatDelta] = useState(props.initialRegion.latitudeDelta);

    useImperativeHandle(ref, () => ({
        animateToRegion(region: MapRegion, duration = 400) {
            mapRef.current?.animateToRegion(region, duration);
        },
    }));

    const showCadastral = props.mapType === 'cadastral' && !!props.vworldApiKey && latDelta < CADASTRAL_MIN_LAT_DELTA;

    const googleMapType = 'standard';

    return (
        <MapView
            ref={mapRef}
            provider={PROVIDER_GOOGLE}
            mapType={googleMapType}
            style={[{ flex: 1 }, props.style]}
            initialRegion={props.initialRegion}
            onRegionChangeComplete={(region) => {
                setLatDelta(region.latitudeDelta);
                props.onRegionChangeComplete?.(region);
            }}
            onPress={(e) => props.onPress?.(e.nativeEvent.coordinate)}
            onMapReady={() => {
                props.onLoadProgress?.('sdkLoaded');
                props.onLoadProgress?.('mapReady');
                props.onReady?.();
            }}
            showsUserLocation={false}
            showsMyLocationButton={false}
        >
            {/* VWorld 지적도 WMS 오버레이 - zoom 14+ 에서만 표시 */}
            {showCadastral && (
                <>
                    <WMSTile
                        urlTemplate={`https://api.vworld.kr/req/wms?key=${props.vworldApiKey}&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=lp_pa_cbnd_bonbun&STYLES=lp_pa_cbnd_bonbun_line&CRS=EPSG:900913&BBOX={minX},{minY},{maxX},{maxY}&WIDTH=512&HEIGHT=512&FORMAT=image/png&TRANSPARENT=true`}
                        tileSize={512}
                        opacity={0.75}
                        zIndex={2}
                    />
                    <WMSTile
                        urlTemplate={`https://api.vworld.kr/req/wms?key=${props.vworldApiKey}&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=lp_pa_cbnd_bubun&STYLES=lp_pa_cbnd_bubun_line&CRS=EPSG:900913&BBOX={minX},{minY},{maxX},{maxY}&WIDTH=512&HEIGHT=512&FORMAT=image/png&TRANSPARENT=true`}
                        tileSize={512}
                        opacity={0.75}
                        zIndex={3}
                    />
                </>
            )}

            {/* 마커 목록 */}
            {props.markers?.map((m) => (
                <Marker
                    key={m.id}
                    coordinate={{ latitude: m.latitude, longitude: m.longitude }}
                    pinColor={m.color || '#FF5722'}
                    title={m.title}
                    onPress={() => props.onMarkerPress?.(m.id, m.type)}
                />
            ))}

            {/* 선택된 마커 (파란 핀) */}
            {props.selectedMarker && (
                <Marker
                    coordinate={props.selectedMarker}
                    pinColor="#1976D2"
                />
            )}

            {/* 사용자 위치 나침반 마커 */}
            {props.userLocation && (
                <Marker
                    coordinate={props.userLocation}
                    anchor={{ x: 0.5, y: 0.5 }}
                    tracksViewChanges={props.heading !== null && props.heading !== undefined}
                >
                    <CompassMarker heading={props.heading ?? null} />
                </Marker>
            )}
        </MapView>
    );
});

export default GoogleMapView;
