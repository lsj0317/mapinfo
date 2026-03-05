import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { View, Text } from 'react-native';
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
    mapType?: 'standard' | 'cadastral' | 'satellite';
    selectedMarker?: { latitude: number; longitude: number } | null;
    markers?: MapMarkerItem[];
    userLocation?: { latitude: number; longitude: number } | null;
    onReady?: () => void;
    onLoadProgress?: (stage: 'sdkLoaded' | 'mapReady') => void;
}

// latitudeDelta < 0.04 ≈ zoom 14+ (지적도 표시 기준)
const CADASTRAL_MIN_LAT_DELTA = 0.04;
// latitudeDelta < 0.1 ≈ zoom 12+ (위성뷰 지적도 표시 기준, 멀리서도 보이게)
const SATELLITE_CADASTRAL_MIN_LAT_DELTA = 0.1;

const GoogleMapView = forwardRef<GoogleMapHandle, Props>((props, ref) => {
    const mapRef = useRef<MapView>(null);
    const [latDelta, setLatDelta] = useState(props.initialRegion.latitudeDelta);

    useImperativeHandle(ref, () => ({
        animateToRegion(region: MapRegion, duration = 400) {
            mapRef.current?.animateToRegion(region, duration);
        },
    }));

    const showCadastral = props.mapType === 'cadastral' && !!props.vworldApiKey && latDelta < CADASTRAL_MIN_LAT_DELTA;
    const showSatelliteCadastral = props.mapType === 'satellite' && !!props.vworldApiKey && latDelta < SATELLITE_CADASTRAL_MIN_LAT_DELTA;

    const googleMapType = props.mapType === 'satellite' ? 'satellite' : 'standard';

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
                setTimeout(() => {
                    props.onLoadProgress?.('mapReady');
                    props.onReady?.();
                }, 800);
            }}
            showsUserLocation={true}
            showsMyLocationButton={false}
        >
            {/* VWorld 지적도 WMS 오버레이 - zoom 14+ 에서만 표시 */}
            {showCadastral && (
                <>
                    <WMSTile
                        urlTemplate={`https://api.vworld.kr/req/wms?key=${props.vworldApiKey}&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=lp_pa_cbnd_bonbun&STYLES=lp_pa_cbnd_bonbun_line&CRS=EPSG:900913&BBOX={minX},{minY},{maxX},{maxY}&WIDTH={width}&HEIGHT={height}&FORMAT=image/png&TRANSPARENT=true`}
                        tileSize={256}
                        opacity={0.75}
                        zIndex={2}
                    />
                    <WMSTile
                        urlTemplate={`https://api.vworld.kr/req/wms?key=${props.vworldApiKey}&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=lp_pa_cbnd_bubun&STYLES=lp_pa_cbnd_bubun_line&CRS=EPSG:900913&BBOX={minX},{minY},{maxX},{maxY}&WIDTH={width}&HEIGHT={height}&FORMAT=image/png&TRANSPARENT=true`}
                        tileSize={256}
                        opacity={0.75}
                        zIndex={3}
                    />
                </>
            )}

            {/* 위성뷰에서 지적도 오버레이 (반투명) - zoom 12+ 에서 표시 */}
            {showSatelliteCadastral && (
                <>
                    <WMSTile
                        urlTemplate={`https://api.vworld.kr/req/wms?key=${props.vworldApiKey}&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=lp_pa_cbnd_bonbun&STYLES=lp_pa_cbnd_bonbun_line&CRS=EPSG:900913&BBOX={minX},{minY},{maxX},{maxY}&WIDTH={width}&HEIGHT={height}&FORMAT=image/png&TRANSPARENT=true`}
                        tileSize={256}
                        opacity={0.6}
                        zIndex={2}
                    />
                    <WMSTile
                        urlTemplate={`https://api.vworld.kr/req/wms?key=${props.vworldApiKey}&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=lp_pa_cbnd_bubun&STYLES=lp_pa_cbnd_bubun_line&CRS=EPSG:900913&BBOX={minX},{minY},{maxX},{maxY}&WIDTH={width}&HEIGHT={height}&FORMAT=image/png&TRANSPARENT=true`}
                        tileSize={256}
                        opacity={0.6}
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

            {/* 커스텀 사용자 위치 마커 */}
            {props.userLocation && (
                <Marker
                    coordinate={props.userLocation}
                    anchor={{ x: 0.5, y: 0.5 }}
                >
                    <View style={{ backgroundColor: '#18181B', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1.5, borderColor: '#FAFAFA' }}>
                        <Text style={{ color: '#FAFAFA', fontSize: 11, fontWeight: '600' }}>내위치</Text>
                    </View>
                </Marker>
            )}
        </MapView>
    );
});

export default GoogleMapView;
