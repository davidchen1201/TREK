import L from 'leaflet';
import { Bus, Car, Hotel, Luggage, Map, MessageCircle, Plane, Ship, Ticket, Train, Wallet } from 'lucide-react';
import { createElement, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useParams } from 'react-router';
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap, ZoomControl } from 'react-leaflet';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getCategoryIcon } from '../components/shared/categoryIcons';
import { sanitizedMarkdownComponents, sanitizedMarkdownPlugins } from '../components/shared/markdownSanitize';
import PublicLanguagePicker from '../components/shared/PublicLanguagePicker';
import { DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM } from '../constants/mapDefaults';
import { useTranslation } from '../i18n';
import { avatarSrc } from '../utils/avatarSrc';
import { getTransportForDay, hidesOnMiddleDay } from '../utils/dayMerge';
import { isDayInAccommodationRange } from '../utils/dayOrder';
import { getFlightLegs, getTrainLegs } from '../utils/flightLegs';
import { splitReservationDateTime } from '../utils/formatters';
import { renderIconMarkup } from '../utils/iconMarkup';
import { computeMapViewport, TILE_SIZE_RASTER } from '../utils/mapViewport';
import { safeHexColor } from '../utils/safeColor';
import { AddSharedNote, DayChevron, EditableDayTitle, EditableSharedNote } from './sharedTrip/SharedItineraryEditor';
import { useSharedTrip } from './sharedTrip/useSharedTrip';

const TRANSPORT_ICONS = { flight: Plane, train: Train, bus: Bus, car: Car, cruise: Ship };
const SHARED_MAP_MAX_ZOOM = 18;
const SHARED_OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>';

// Injected into Leaflet's marker HTML, where CSS variables cannot reach - the same
// reason MapView.tsx is exempt from theme:lint outright.
const ORDER_BADGE_STYLE =
  'position:absolute;bottom:-4px;right:-4px;min-width:16px;height:16px;border-radius:8px;padding:0 3px;background:rgba(255,255,255,0.94);border:1.5px solid rgba(0,0,0,0.15);box-shadow:0 1px 4px rgba(0,0,0,0.18);display:flex;align-items:center;justify-content:center;font-weight:800;color:#111827;line-height:1;box-sizing:border-box;white-space:nowrap;'; // theme-lint-disable

function createMarkerIcon(place: any, orderNumbers?: number[] | null) {
  const cat = place.category;
  // This page answers without a guard, so an unescaped colour here reaches
  // people who have no account on the instance at all.
  // The shared payload nests a category on day assignments, while older payloads
  // can carry its colour/icon flat on the place itself.
  const color = safeHexColor(cat?.color ?? place.category_color, '#6366f1');
  const CatIcon = getCategoryIcon(cat?.icon ?? place.category_icon);
  const iconSvg = renderIconMarkup(createElement(CatIcon, { size: 14, strokeWidth: 2, color: 'white' }));
  // Position in the day's order, same contract as the planner: a stop the day
  // visits twice shows both, e.g. "1 . 3". The values are array indices, never payload.
  const badge = orderNumbers?.length
    ? `<span style="${ORDER_BADGE_STYLE}font-size:${orderNumbers.length > 1 ? 7.5 : 9}px;">${orderNumbers.join(' \u00b7 ')}</span>`
    : '';
  return L.divIcon({
    className: '',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    html: `<div style="position:relative;width:28px;height:28px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.3);border:2px solid white;">${iconSvg}${badge}</div>`,
  });
}

/** A public share must not guess a location from an address. In particular, zero
 * is a real coordinate (Null Island / equator / prime meridian), not a missing
 * value, so truthiness checks are deliberately avoided here. */
function hasCoordinates(place: any): boolean {
  const lat = place?.lat;
  const lng = place?.lng;
  return (
    lat !== null &&
    lat !== undefined &&
    lng !== null &&
    lng !== undefined &&
    Number.isFinite(Number(lat)) &&
    Number.isFinite(Number(lng)) &&
    Number(lat) >= -90 &&
    Number(lat) <= 90 &&
    Number(lng) >= -180 &&
    Number(lng) <= 180
  );
}

function mappedPlace(place: any) {
  return { ...place, lat: Number(place.lat), lng: Number(place.lng) };
}

function placeTime(place: any): string | null {
  const start = place?.place_time;
  const end = place?.end_time;
  return start ? `${start}${end ? ` – ${end}` : ''}` : null;
}

function FitBoundsToPlaces({ places }: { places: any[] }) {
  const map = useMap();
  // The page rebuilds this array on every render (a Page body may not memoise), so
  // keying the effect on the coordinates rather than the array identity is what stops
  // an unrelated re-render - the language picker, a late FX response - from throwing
  // the viewer's pan and zoom away.
  const fitKey = places.map((p) => `${p.lat},${p.lng}`).join('|');
  useEffect(() => {
    if (places.length === 0) return;
    // Leaflet knows the map's real rendered dimensions; unlike the lightweight
    // viewport estimate used for its first paint, this cannot leave pins clipped
    // at either edge.
    const bounds = L.latLngBounds(places.map((p) => [p.lat, p.lng]));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
  }, [fitKey, map]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** Opens the marker's own Leaflet popup after a daily-place chip is chosen. The
 * map remains entirely in this page: there is no Google Maps hand-off. */
function FocusMapPlace({ place, markerRefs }: { place: any | null; markerRefs: MutableRefObject<Record<string, any>> }) {
  const map = useMap();
  const focusKey = place ? `${place.id}:${place.lat}:${place.lng}` : '';

  useEffect(() => {
    if (!place || !hasCoordinates(place)) return;
    const currentZoom = map.getZoom?.() ?? 14;
    map.flyTo?.([place.lat, place.lng], Math.max(currentZoom, 14), { animate: true, duration: 0.45 });
    markerRefs.current[String(place.id)]?.openPopup?.();
  }, [focusKey, map, markerRefs]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

export default function SharedTripPage() {
  const { t, locale } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const [focusedMapPlace, setFocusedMapPlace] = useState<{ dayId: number; placeId: number } | null>(null);
  const [tileError, setTileError] = useState(false);
  const markerRefs = useRef<Record<string, any>>({});
  const mapWrapperRef = useRef<HTMLDivElement | null>(null);
  // Page = wiring container: share fetch + view state live in the hook.
  const {
    data,
    error,
    base,
    convert,
    selectedDay,
    setSelectedDay,
    activeTab,
    setActiveTab,
    showLangPicker,
    setShowLangPicker,
    editable,
    updateDay,
    createDayNote,
    updateDayNote,
    deleteDayNote,
  } = useSharedTrip();

  if (error)
    return (
      <div
        className="bg-[#f3f4f6]"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}
      >
        <div style={{ textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 'calc(48px * var(--fs-scale-title, 1))', marginBottom: 16 }}>🔒</div>
          <h1 className="text-[#111827]" style={{ fontSize: 'calc(20px * var(--fs-scale-title, 1))', fontWeight: 700 }}>
            {t('shared.expired')}
          </h1>
          <p className="text-[#6b7280]" style={{ marginTop: 8 }}>
            {t('shared.expiredHint')}
          </p>
        </div>
      </div>
    );

  if (!data)
    return (
      <div
        className="bg-[#f3f4f6]"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            border: '3px solid #e5e7eb',
            borderTopColor: '#111827',
            borderRadius: '50%',
            animation: 'spin 0.6s linear infinite',
          }}
        />
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    );

  const {
    trip,
    days,
    assignments,
    dayNotes,
    reservations,
    accommodations,
    packing,
    budget,
    categories,
    permissions,
    collab,
  } = data;
  const sortedDays = [...(days || [])].sort((a: any, b: any) => a.day_number - b.day_number);
  const displayChinese =
    locale.toLowerCase().startsWith('zh') ||
    /[\u4e00-\u9fff]/.test(
      [
        trip.title,
        trip.description,
        ...Object.values(dayNotes || {})
          .flat()
          .map((note: any) => note.text),
      ]
        .filter(Boolean)
        .join(' ')
    );
  const displayLocale = displayChinese ? 'zh-CN' : locale;
  // The index runs over the full sorted assignment list, so a stop without
  // coordinates still consumes a number and the share page agrees with the planner.
  const dayAssignments = selectedDay
    ? [...(assignments[String(selectedDay)] || [])].sort((a: any, b: any) => a.order_index - b.order_index)
    : [];
  const dayOrderMap: Record<number, number[]> = {};
  dayAssignments.forEach((a: any, i: number) => {
    if (!a.place?.id) return;
    (dayOrderMap[a.place.id] ||= []).push(i + 1);
  });
  const dayPlaces: any[] = [];
  const seenPlaceIds = new Set<number>();
  for (const a of dayAssignments as any[]) {
    const p = a.place;
    if (!p?.id || !hasCoordinates(p) || seenPlaceIds.has(p.id)) continue;
    seenPlaceIds.add(p.id);
    dayPlaces.push(mappedPlace(p));
  }
  // The selected day is the only map scope. Keep the route sequence separate
  // from unique markers so repeated stops do not create duplicate marker keys.
  const dayRoutePlaces = dayAssignments
    .map((assignment: any) => assignment.place)
    .filter((place: any) => hasCoordinates(place))
    .map(mappedPlace);
  const mapPlaces = dayPlaces;
  const focusedPlace =
    focusedMapPlace?.dayId === selectedDay
      ? mapPlaces.find((place: any) => place.id === focusedMapPlace.placeId) ?? null
      : null;
  const selectedDayHasPlaces = dayAssignments.some((assignment: any) => assignment.place);

  // Open framed on the selected day's verified places. MapContainer only reads
  // center/zoom at mount; the fit helper handles later day changes.
  const framed = computeMapViewport(mapPlaces, {
    tileSize: TILE_SIZE_RASTER,
    padding: { top: 40, right: 40, bottom: 40, left: 40 },
  });
  const initialView = framed ?? { center: DEFAULT_MAP_CENTER, zoom: DEFAULT_MAP_ZOOM };
  const tileUrl = `/api/shared/${encodeURIComponent(token || '')}/map-tiles/{z}/{x}/{y}.png`;
  const chooseDay = (dayId: number) => {
    setFocusedMapPlace(null);
    setTileError(false);
    setSelectedDay(dayId);
  };
  const focusDailyPlace = (dayId: number, place: any) => {
    if (!hasCoordinates(place)) return;
    mapWrapperRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    setTileError(false);
    setFocusedMapPlace({ dayId, placeId: place.id });
    setSelectedDay(dayId);
  };

  return (
    <div
      className="bg-surface-secondary"
      style={{ minHeight: '100vh', fontFamily: 'var(--font-system)', background: '#f7f5ef' }}
    >
      {/* Header */}
      <div
        className="text-white"
        style={{
          background: 'linear-gradient(120deg, #173d35 0%, #2e6253 55%, #6d8261 100%)',
          padding: '24px 20px 22px',
          textAlign: 'center',
          position: 'relative',
        }}
      >
        {/* Cover image background */}
        {trip.cover_image && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              backgroundImage: `url(${trip.cover_image.startsWith('http') ? trip.cover_image : trip.cover_image.startsWith('/') ? trip.cover_image : '/uploads/' + trip.cover_image})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              opacity: 0.15,
            }}
          />
        )}
        {/* Background decoration */}
        <div
          className="bg-[rgba(255,255,255,0.03)]"
          style={{ position: 'absolute', top: -60, right: -60, width: 200, height: 200, borderRadius: '50%' }}
        />
        <div
          className="bg-[rgba(255,255,255,0.02)]"
          style={{ position: 'absolute', bottom: -40, left: -40, width: 150, height: 150, borderRadius: '50%' }}
        />

        {/* Logo */}
        <div
          className="bg-[rgba(255,255,255,0.08)]"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 44,
            height: 44,
            borderRadius: 12,
            backdropFilter: 'blur(8px)',
            marginBottom: 12,
            border: '1px solid rgba(255,255,255,0.1)',
          }}
        >
          <img src="/icons/icon-white.svg" alt="TREK" width="26" height="26" />
        </div>

        <div
          style={{
            fontSize: 'calc(10px * var(--fs-scale-caption, 1))',
            fontWeight: 600,
            letterSpacing: 3,
            textTransform: 'uppercase',
            opacity: 0.35,
            marginBottom: 12,
          }}
        >
          Travel Resource & Exploration Kit
        </div>

        <h1
          style={{
            position: 'relative',
            margin: '0 auto 4px',
            maxWidth: 760,
            fontSize: 'clamp(28px, 5vw, 42px)',
            lineHeight: 1.12,
            fontWeight: 760,
            letterSpacing: '-0.04em',
          }}
        >
          {trip.title}
        </h1>

        {trip.description && trip.description.length <= 240 && (
          <p
            style={{
              position: 'relative',
              fontSize: '16px',
              opacity: 0.76,
              maxWidth: 650,
              margin: '12px auto 0',
              lineHeight: 1.6,
            }}
          >
            {trip.description}
          </p>
        )}

        {(trip.start_date || trip.end_date) && (
          <div
            className="bg-[rgba(255,255,255,0.08)]"
            style={{
              marginTop: 10,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 14px',
              borderRadius: 20,
              backdropFilter: 'blur(4px)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <span style={{ fontSize: '14px', fontWeight: 500, opacity: 0.8 }}>
              {[trip.start_date, trip.end_date]
                .filter(Boolean)
                .map((d: string) =>
                  new Date(d + 'T00:00:00Z').toLocaleDateString(locale, {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                    timeZone: 'UTC',
                  })
                )
                .join(' — ')}
            </span>
            {days?.length > 0 && (
              <span style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))', opacity: 0.4 }}>·</span>
            )}
            {days?.length > 0 && (
              <span style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))', opacity: 0.5 }}>
                {days.length} {t('shared.days')}
              </span>
            )}
          </div>
        )}

        <div
          style={{
            marginTop: 12,
            fontSize: 'calc(9px * var(--fs-scale-caption, 1))',
            fontWeight: 500,
            letterSpacing: 1.5,
            textTransform: 'uppercase',
            opacity: 0.25,
          }}
        >
          {editable
            ? locale.toLowerCase().startsWith('zh')
              ? '可编辑行程'
              : 'Editable itinerary'
            : t('shared.readOnly')}
        </div>

        <PublicLanguagePicker locale={locale} open={showLangPicker} onOpenChange={setShowLangPicker} />
      </div>

      <div style={{ maxWidth: 980, margin: '0 auto', padding: '20px 16px 36px' }}>
        {trip.description && trip.description.length > 240 && (
          <details
            style={{
              marginBottom: 18,
              padding: '14px 18px',
              background: '#fff',
              border: '1px solid #e2e8f0',
              borderRadius: 14,
              boxShadow: '0 2px 10px rgba(15,23,42,.04)',
            }}
          >
            <summary style={{ cursor: 'pointer', fontSize: 16, fontWeight: 720, color: '#1e293b' }}>
              {displayChinese ? '行程资料' : 'Trip details'}
            </summary>
            <div style={{ marginTop: 12, fontSize: 16, lineHeight: 1.75, color: '#475569' }}>
              <Markdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={sanitizedMarkdownPlugins}
                components={sanitizedMarkdownComponents}
              >
                {trip.description}
              </Markdown>
            </div>
          </details>
        )}
        {/* Tabs */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 20, overflowX: 'auto', padding: '2px 0' }}>
          {[
            ...(permissions?.share_map !== false ? [{ id: 'plan', label: t('shared.tabPlan'), Icon: Map }] : []),
            ...(permissions?.share_bookings ? [{ id: 'bookings', label: t('shared.tabBookings'), Icon: Ticket }] : []),
            ...(permissions?.share_packing ? [{ id: 'packing', label: t('shared.tabPacking'), Icon: Luggage }] : []),
            ...(permissions?.share_budget ? [{ id: 'budget', label: t('shared.tabBudget'), Icon: Wallet }] : []),
            ...(permissions?.share_collab ? [{ id: 'collab', label: t('shared.tabChat'), Icon: MessageCircle }] : []),
          ].map((tab) => (
            <button
              type="button"
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={activeTab === tab.id ? 'bg-[#111827] text-white' : 'bg-surface-card text-[#6b7280]'}
              style={{
                padding: '8px 18px',
                borderRadius: 12,
                border: '1.5px solid',
                cursor: 'pointer',
                fontSize: 'calc(12px * var(--fs-scale-body, 1))',
                fontWeight: 600,
                fontFamily: 'inherit',
                transition: 'all 0.15s',
                whiteSpace: 'nowrap',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                borderColor: activeTab === tab.id ? '#111827' : 'var(--border-faint, #e5e7eb)',
                boxShadow: activeTab === tab.id ? '0 2px 8px rgba(0,0,0,0.15)' : '0 1px 3px rgba(0,0,0,0.04)',
              }}
            >
              <tab.Icon size={13} />
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Map */}
        {activeTab === 'plan' && (
          <>
            {/* Day picker at the map. Same setter as the day card below, so the map and
                the expanded day can never disagree. Without it the only way to narrow the
                map down was a control 300px further down the page. */}
            {sortedDays.length > 0 && (
              <div
                ref={mapWrapperRef}
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 5,
                  display: 'flex',
                  gap: 7,
                  overflowX: 'auto',
                  margin: '0 -16px 14px',
                  padding: '10px 16px',
                  background: 'rgba(247,245,239,.94)',
                  backdropFilter: 'blur(12px)',
                  borderBottom: '1px solid #e7e3d9',
                }}
              >
                {sortedDays.map((day: any) => {
                  const id = day.id;
                  const active = selectedDay === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => chooseDay(id)}
                      aria-pressed={active}
                      // Same literals as the day-number circle below. This page pins itself
                      // to the light neutral look (applyAppearance skips /shared/*), so a
                      // token here would not be value-equal to the rest of the card.
                      className={active ? 'bg-[#1f5b4e] text-white' : 'bg-[#f3f4f6] text-[#6b7280]'} // theme-lint-disable
                      style={{
                        padding: '8px 13px',
                        borderRadius: 11,
                        border: 'none',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        fontWeight: 600,
                        fontFamily: 'inherit',
                        flexShrink: 0,
                        fontSize: 'calc(12px * var(--fs-scale-body, 1))',
                      }}
                    >
                      {`${t('dayplan.dayN', { n: day.day_number })}${day.date ? ` · ${new Date(day.date + 'T00:00:00Z').toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' })}` : ''}`}
                    </button>
                  );
                })}
              </div>
            )}
            {mapPlaces.length > 0 ? (
              <div
                style={{
                  position: 'relative',
                  borderRadius: 16,
                  overflow: 'hidden',
                  height: 'clamp(320px, 48vw, 390px)',
                  marginBottom: 20,
                  boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
                }}
              >
                <MapContainer
                  center={initialView.center}
                  zoom={initialView.zoom}
                  zoomControl={false}
                  // Keep Leaflet's zoom ceiling explicit so a later fitBounds has a
                  // finite limit even though this is a token-scoped raster layer.
                  maxZoom={SHARED_MAP_MAX_ZOOM}
                  style={{ width: '100%', height: '100%' }}
                >
                  <ZoomControl position="topright" />
                  <TileLayer
                    url={tileUrl}
                    attribution={SHARED_OSM_ATTRIBUTION}
                    maxZoom={SHARED_MAP_MAX_ZOOM}
                    noWrap
                    referrerPolicy="origin"
                    eventHandlers={{ tileerror: () => setTileError(true) }}
                  />
                  <FitBoundsToPlaces places={mapPlaces} />
                  <FocusMapPlace place={focusedPlace} markerRefs={markerRefs} />
                  {dayRoutePlaces.length > 1 && (
                    <Polyline
                      positions={dayRoutePlaces.map((p: any) => [p.lat, p.lng])}
                      // Dashed and straight on purpose: it shows the order of the day's stops,
                      // not the roads between them. A real route would mean sending the
                      // itinerary to a third party for every anonymous visitor of a shared
                      // link, with no way for the trip's owner to opt out.
                      pathOptions={{ color: '#2e6253', weight: 3, opacity: 0.78, dashArray: '6 8', lineCap: 'round' }} // theme-lint-disable
                      interactive={false}
                    />
                  )}
                  {mapPlaces.map((p: any) => (
                    <Marker
                      key={p.id}
                      position={[p.lat, p.lng]}
                      icon={createMarkerIcon(p, dayOrderMap[p.id] ?? null)}
                      ref={(marker) => {
                        if (marker) markerRefs.current[String(p.id)] = marker;
                      }}
                    >
                      <Popup>
                        <div style={{ minWidth: 128, color: '#1e293b', fontFamily: 'var(--font-system)' }}>
                          <strong style={{ display: 'block', fontSize: 14 }}>{p.name}</strong>
                          {placeTime(p) && <span style={{ display: 'block', marginTop: 4, color: '#557064', fontSize: 12 }}>{placeTime(p)}</span>}
                        </div>
                      </Popup>
                    </Marker>
                  ))}
                </MapContainer>
                {dayRoutePlaces.length > 1 && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 10,
                      left: 10,
                      zIndex: 500,
                      maxWidth: 'calc(100% - 20px)',
                      padding: '5px 8px',
                      borderRadius: 8,
                      color: '#245246',
                      background: 'rgba(255,255,255,.91)',
                      boxShadow: '0 1px 5px rgba(25,55,45,.14)',
                      fontSize: 12,
                      fontWeight: 650,
                      pointerEvents: 'none',
                    }}
                  >
                    地点连线，非实际行车路线
                  </div>
                )}
                {tileError && (
                  <div
                    role="status"
                    style={{
                      position: 'absolute',
                      right: 10,
                      bottom: 10,
                      zIndex: 500,
                      maxWidth: 260,
                      padding: '7px 9px',
                      borderRadius: 8,
                      color: '#7c2d12',
                      background: 'rgba(255,247,237,.94)',
                      border: '1px solid #fed7aa',
                      boxShadow: '0 1px 5px rgba(124,45,18,.12)',
                      fontSize: 12,
                      lineHeight: 1.4,
                    }}
                  >
                    地图底图暂时无法加载；地点列表仍可使用。
                  </div>
                )}
              </div>
            ) : (
              <div
                style={{
                  minHeight: 320,
                  marginBottom: 20,
                  display: 'grid',
                  placeItems: 'center',
                  border: '1px dashed #b8cbbd',
                  borderRadius: 16,
                  color: '#557064',
                  background: '#edf3ed',
                  textAlign: 'center',
                  padding: 24,
                }}
              >
                <div>
                  <Map size={24} style={{ margin: '0 auto 8px' }} />
                  <div style={{ fontWeight: 750 }}>{selectedDayHasPlaces ? '位置待补充' : '当天暂无地图地点'}</div>
                  {selectedDayHasPlaces && <div style={{ marginTop: 5, fontSize: 13 }}>地点资料保留在下方行程中。</div>}
                </div>
              </div>
            )}

            {/* Day Plan */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {sortedDays.map((day: any, di: number) => {
                const da = assignments[String(day.id)] || [];
                // A share can still carry an assignment for a deleted place. The timeline
                // skips those rows, so the header must not count them either.
                const dayPlaceCount = da.filter((a: any) => a.place).length;
                const notes = dayNotes[String(day.id)] || [];
                const dayAssignmentIds: number[] = da.map((a: any) => a.id);
                const dayTransport = getTransportForDay({
                  reservations: reservations || [],
                  dayId: day.id,
                  dayAssignmentIds,
                  days: sortedDays,
                });
                const dayAccs = (accommodations || []).filter((a: any) =>
                  isDayInAccommodationRange(day, a.start_day_id, a.end_day_id, sortedDays)
                );

                const visibleTransport = dayTransport.filter((item: any) => !hidesOnMiddleDay(item, day.id));
                const isChinese = displayChinese;

                return (
                  <div
                    key={day.id}
                    className="border border-edge-faint bg-surface-card"
                    style={{
                      borderRadius: 18,
                      overflow: 'hidden',
                      borderColor: '#e2e8df',
                      boxShadow: '0 5px 16px rgba(35,55,45,.06)',
                    }}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => chooseDay(day.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') chooseDay(day.id);
                      }}
                      aria-expanded={selectedDay === day.id}
                      style={{
                        padding: '18px 20px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 13,
                        width: '100%',
                        background: 'linear-gradient(90deg, #ffffff, #f8fafc)',
                        textAlign: 'left',
                        fontFamily: 'inherit',
                      }}
                    >
                      <div
                        style={{
                          width: 38,
                          height: 38,
                          borderRadius: 12,
                          display: 'grid',
                          placeItems: 'center',
                          background: selectedDay === day.id ? '#1f5b4e' : '#e8eef6',
                          color: selectedDay === day.id ? '#fff' : '#475569',
                          fontSize: 14,
                          fontWeight: 800,
                          flexShrink: 0,
                        }}
                      >
                        {di + 1}
                      </div>
                      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                        <EditableDayTitle
                          day={day}
                          editable={editable}
                          locale={displayLocale}
                          onSave={(title) => updateDay(day.id, title)}
                        />
                        {day.date && (
                          <div style={{ color: '#64748b', fontSize: 14, marginTop: 3, fontWeight: 550 }}>
                            {new Date(day.date + 'T00:00:00Z').toLocaleDateString(locale, {
                              weekday: 'long',
                              day: 'numeric',
                              month: 'long',
                              timeZone: 'UTC',
                            })}
                          </div>
                        )}
                      </div>
                      {dayAccs.slice(0, 1).map((acc: any) => (
                        <span
                          key={acc.id}
                          style={{
                            padding: '5px 8px',
                            borderRadius: 8,
                            background: '#eff6ff',
                            color: '#1d4ed8',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            fontSize: 12,
                            fontWeight: 650,
                            maxWidth: 160,
                          }}
                        >
                          <Hotel size={13} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {acc.place_name}
                          </span>
                        </span>
                      ))}
                      <span
                        style={{ color: '#64748b', fontSize: 13, fontWeight: 650, flexShrink: 0, whiteSpace: 'nowrap' }}
                      >
                        {dayPlaceCount} {t('shared.places')}
                      </span>
                      <DayChevron open={selectedDay === day.id} />
                    </div>

                    {selectedDay === day.id && (
                      <div style={{ padding: '0 20px 20px', display: 'flex', flexDirection: 'column', gap: 17 }}>
                        {da.filter((assignment: any) => assignment.place).length > 0 && (
                          <section aria-label={isChinese ? '每日地点' : 'Places for the day'}>
                            <div
                              style={{
                                color: '#64748b',
                                fontSize: 13,
                                fontWeight: 800,
                                letterSpacing: '.08em',
                                marginBottom: 9,
                              }}
                            >
                              {isChinese ? '每日地点' : 'DAILY PLACES'}
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                              {da
                                .filter((assignment: any) => assignment.place)
                                .map((assignment: any) => {
                                  const place = assignment.place;
                                  const category = categories?.find((item: any) => item.id === place.category_id);
                                  const canFocusMap = hasCoordinates(place);
                                  return (
                                    <button
                                      type="button"
                                      key={assignment.id}
                                      onClick={() => focusDailyPlace(day.id, place)}
                                      disabled={!canFocusMap}
                                      aria-label={
                                        canFocusMap
                                          ? `${place.name}：在地图中查看`
                                          : `${place.name}：位置待补充`
                                      }
                                      style={{
                                        display: 'inline-flex',
                                        maxWidth: '100%',
                                        alignItems: 'center',
                                        gap: 7,
                                        padding: '8px 10px',
                                        color: '#1e293b',
                                        background: '#fff',
                                        border: '1px solid #dbe3ee',
                                        borderRadius: 10,
                                        textDecoration: 'none',
                                        boxShadow: '0 1px 3px rgba(15,23,42,.04)',
                                        fontSize: 14,
                                        fontWeight: 650,
                                        fontFamily: 'inherit',
                                        cursor: canFocusMap ? 'pointer' : 'not-allowed',
                                        opacity: canFocusMap ? 1 : 0.7,
                                      }}
                                    >
                                      <span
                                        style={{
                                          width: 8,
                                          height: 8,
                                          borderRadius: 99,
                                          background: category?.color || place.category?.color || '#6366f1',
                                          flexShrink: 0,
                                        }}
                                      />
                                      <span
                                        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                      >
                                        {place.name}
                                      </span>
                                      {!canFocusMap && (
                                        <span style={{ color: '#8a5a2b', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
                                          位置待补充
                                        </span>
                                      )}
                                    </button>
                                  );
                                })}
                            </div>
                          </section>
                        )}
                        {visibleTransport.length > 0 && (
                          <section aria-label={isChinese ? '出行' : 'Travel'}>
                            <div
                              style={{
                                color: '#64748b',
                                fontSize: 13,
                                fontWeight: 800,
                                letterSpacing: '.08em',
                                marginBottom: 9,
                              }}
                            >
                              {isChinese ? '出行安排' : 'TRAVEL'}
                            </div>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              {visibleTransport.map((reservation: any) => {
                                const Icon = TRANSPORT_ICONS[reservation.type] || Ticket;
                                const time = splitReservationDateTime(reservation.reservation_time).time;
                                return (
                                  <div
                                    key={
                                      reservation.__leg
                                        ? `${reservation.id}-${reservation.__leg.index}`
                                        : reservation.id
                                    }
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: 7,
                                      padding: '8px 10px',
                                      borderRadius: 10,
                                      background: '#eff6ff',
                                      color: '#1e40af',
                                      fontSize: 14,
                                      fontWeight: 650,
                                    }}
                                  >
                                    <Icon size={15} />
                                    {reservation.title}
                                    {time ? ` · ${time}` : ''}
                                  </div>
                                );
                              })}
                            </div>
                          </section>
                        )}
                        <section aria-label={isChinese ? '日程清单' : 'Schedule checklist'}>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'baseline',
                              justifyContent: 'space-between',
                              gap: 10,
                              marginBottom: 9,
                            }}
                          >
                            <div style={{ color: '#64748b', fontSize: 13, fontWeight: 800, letterSpacing: '.08em' }}>
                              {isChinese ? '日程清单' : 'SCHEDULE'}
                            </div>
                            <div style={{ color: '#94a3b8', fontSize: 13 }}>
                              {notes.length} {isChinese ? '项' : 'items'}
                            </div>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {notes.map((note: any) => (
                              <EditableSharedNote
                                key={note.id}
                                note={note}
                                editable={editable}
                                locale={displayLocale}
                                onSave={(patch) =>
                                  updateDayNote(day.id, note.id, {
                                    ...patch,
                                    icon: note.icon,
                                    sort_order: note.sort_order,
                                    color: note.color,
                                  })
                                }
                                onDelete={() => deleteDayNote(day.id, note.id)}
                              />
                            ))}
                            {notes.length === 0 && !editable && (
                              <div
                                style={{
                                  color: '#64748b',
                                  background: '#f8fafc',
                                  padding: '14px',
                                  borderRadius: 11,
                                  fontSize: 15,
                                }}
                              >
                                {isChinese ? '当天还没有日程项目。' : 'No scheduled items for this day yet.'}
                              </div>
                            )}
                            {editable && (
                              <AddSharedNote
                                locale={displayLocale}
                                onAdd={(text, time) =>
                                  createDayNote(day.id, {
                                    text: `[ ] ${text}`,
                                    time: time || null,
                                    icon: '📝',
                                    sort_order:
                                      Math.max(0, ...notes.map((note: any) => Number(note.sort_order) || 0)) + 1,
                                    color: null,
                                  })
                                }
                              />
                            )}
                          </div>
                        </section>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* Bookings */}
        {activeTab === 'bookings' && (reservations || []).length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(reservations || []).map((r: any) => {
              const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata || '{}') : r.metadata || {};
              const TIcon = TRANSPORT_ICONS[r.type] || Ticket;
              const { date: rDate, time: rTime } = splitReservationDateTime(r.reservation_time);
              const time = rTime ?? '';
              const date = rDate
                ? new Date(rDate + 'T00:00:00Z').toLocaleDateString(locale, {
                    day: 'numeric',
                    month: 'short',
                    timeZone: 'UTC',
                  })
                : '';
              return (
                <div
                  key={r.id}
                  className="border border-edge-faint bg-surface-card"
                  style={{ borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}
                >
                  <div
                    className="bg-[#f3f4f6]"
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <TIcon size={15} color="#6b7280" />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      className="text-[#111827]"
                      style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 600 }}
                    >
                      {r.title}
                    </div>
                    <div
                      className="text-[#9ca3af]"
                      style={{
                        fontSize: 'calc(11px * var(--fs-scale-caption, 1))',
                        display: 'flex',
                        gap: 8,
                        flexWrap: 'wrap',
                        marginTop: 2,
                      }}
                    >
                      {date && <span>{date}</span>}
                      {time && <span>{time}</span>}
                      {r.location && <span>{r.location}</span>}
                      {r.type === 'flight'
                        ? getFlightLegs(r).map((leg, i) => (
                            <span key={i}>
                              {[
                                leg.airline,
                                leg.flight_number,
                                leg.from || leg.to ? [leg.from, leg.to].filter(Boolean).join(' → ') : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                            </span>
                          ))
                        : r.type === 'train'
                          ? getTrainLegs(r).map((leg, i) => (
                              <span key={i}>
                                {[
                                  leg.train_number,
                                  leg.platform ? `${t('reservations.meta.platform')} ${leg.platform}` : '',
                                  leg.from || leg.to ? [leg.from, leg.to].filter(Boolean).join(' → ') : '',
                                ]
                                  .filter(Boolean)
                                  .join(' ')}
                              </span>
                            ))
                          : meta.airline && (
                              <span>
                                {meta.airline} {meta.flight_number || ''}
                              </span>
                            )}
                    </div>
                  </div>
                  <span
                    className={
                      r.status === 'confirmed'
                        ? 'bg-[rgba(22,163,74,0.1)] text-[#16a34a]'
                        : 'bg-[rgba(217,119,6,0.1)] text-[#d97706]'
                    }
                    style={{
                      fontSize: 'calc(10px * var(--fs-scale-caption, 1))',
                      padding: '2px 8px',
                      borderRadius: 20,
                      fontWeight: 600,
                    }}
                  >
                    {r.status === 'confirmed' ? t('shared.confirmed') : t('shared.pending')}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Packing */}
        {activeTab === 'packing' && (packing || []).length > 0 && (
          <div
            className="border border-edge-faint bg-surface-card"
            style={{
              borderRadius: 18,
              overflow: 'hidden',
              borderColor: '#e2e8df',
              boxShadow: '0 5px 16px rgba(35,55,45,.06)',
            }}
          >
            {Object.entries(
              (packing || []).reduce((g: any, i: any) => {
                const c = i.category || t('shared.other');
                (g[c] = g[c] || []).push(i);
                return g;
              }, {})
            ).map(([cat, items]: [string, any]) => (
              <div key={cat}>
                <div
                  className="bg-[#f9fafb] text-[#6b7280]"
                  style={{
                    padding: '8px 16px',
                    fontSize: 'calc(11px * var(--fs-scale-caption, 1))',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    borderBottom: '1px solid #f3f4f6',
                  }}
                >
                  {cat}
                </div>
                {items.map((item: any) => (
                  <div
                    key={item.id}
                    style={{
                      padding: '6px 16px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      borderBottom: '1px solid #f9fafb',
                    }}
                  >
                    <span
                      className={item.checked ? 'text-[#9ca3af]' : 'text-[#111827]'}
                      style={{
                        fontSize: 'calc(13px * var(--fs-scale-body, 1))',
                        textDecoration: item.checked ? 'line-through' : 'none',
                      }}
                    >
                      {item.name}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* Budget */}
        {activeTab === 'budget' &&
          (budget || []).length > 0 &&
          (() => {
            // Pre-rework rows store currency = NULL ("the trip's own currency"); convert
            // each expense into the owner's display base via live FX, mirroring CostsPanel.
            const curOf = (i: any) => i.currency || trip.currency || base;
            const grouped = (budget || []).reduce((g: any, i: any) => {
              const c = i.category || t('shared.other');
              (g[c] = g[c] || []).push(i);
              return g;
            }, {});
            const sumIn = (items: any[]) =>
              items.reduce((s: number, i: any) => s + convert(Number.parseFloat(i.total_price) || 0, curOf(i)), 0);
            const total = sumIn(budget || []);
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {/* Total card */}
                <div
                  className="text-white"
                  style={{
                    background: 'linear-gradient(135deg, #000 0%, #1a1a2e 100%)',
                    borderRadius: 14,
                    padding: '20px 24px',
                  }}
                >
                  <div
                    style={{
                      fontSize: 'calc(10px * var(--fs-scale-caption, 1))',
                      fontWeight: 500,
                      letterSpacing: 1,
                      textTransform: 'uppercase',
                      opacity: 0.5,
                    }}
                  >
                    {t('shared.totalBudget')}
                  </div>
                  <div style={{ fontSize: 'calc(28px * var(--fs-scale-title, 1))', fontWeight: 700, marginTop: 4 }}>
                    {total.toLocaleString(locale, { minimumFractionDigits: 2 })} {base}
                  </div>
                </div>
                {/* By category */}
                {Object.entries(grouped).map(([cat, items]: [string, any]) => (
                  <div
                    key={cat}
                    className="border border-edge-faint bg-surface-card"
                    style={{ borderRadius: 12, overflow: 'hidden' }}
                  >
                    <div
                      className="bg-[#f9fafb]"
                      style={{
                        padding: '10px 16px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        borderBottom: '1px solid #f3f4f6',
                      }}
                    >
                      <span
                        className="text-[#374151]"
                        style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontWeight: 700 }}
                      >
                        {cat}
                      </span>
                      <span
                        className="text-[#6b7280]"
                        style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontWeight: 600 }}
                      >
                        {sumIn(items).toLocaleString(locale, { minimumFractionDigits: 2 })} {base}
                      </span>
                    </div>
                    {items.map((item: any) => (
                      <div
                        key={item.id}
                        style={{
                          padding: '8px 16px',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          borderBottom: '1px solid #fafafa',
                        }}
                      >
                        <span className="text-[#111827]" style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))' }}>
                          {item.name}
                        </span>
                        <span
                          className="text-[#111827]"
                          style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 600 }}
                        >
                          {item.total_price
                            ? `${convert(Number.parseFloat(item.total_price) || 0, curOf(item)).toLocaleString(locale, { minimumFractionDigits: 2 })} ${base}`
                            : '—'}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            );
          })()}

        {/* Collab Chat */}
        {activeTab === 'collab' && (collab || []).length > 0 && (
          <div
            className="border border-edge-faint bg-surface-card"
            style={{
              borderRadius: 18,
              overflow: 'hidden',
              borderColor: '#e2e8df',
              boxShadow: '0 5px 16px rgba(35,55,45,.06)',
            }}
          >
            <div
              className="bg-[#f9fafb]"
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid #f3f4f6',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <MessageCircle size={14} color="#6b7280" />
              <span
                className="text-[#374151]"
                style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontWeight: 700 }}
              >
                {t('shared.tabChat')} · {(collab || []).length} {t('shared.messages')}
              </span>
            </div>
            <div
              style={{
                maxHeight: 500,
                overflowY: 'auto',
                padding: '12px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              {(collab || []).map((msg: any, i: number) => {
                const prevMsg = i > 0 ? collab[i - 1] : null;
                const showDate =
                  !prevMsg || new Date(msg.created_at).toDateString() !== new Date(prevMsg.created_at).toDateString();
                return (
                  <div key={msg.id}>
                    {showDate && (
                      <div
                        className="text-[#9ca3af]"
                        style={{
                          textAlign: 'center',
                          margin: '8px 0',
                          fontSize: 'calc(10px * var(--fs-scale-caption, 1))',
                          fontWeight: 600,
                        }}
                      >
                        {new Date(msg.created_at).toLocaleDateString(locale, {
                          weekday: 'short',
                          day: 'numeric',
                          month: 'short',
                        })}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 10 }}>
                      <div
                        className="bg-[#e5e7eb] text-[#6b7280]"
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: '50%',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 'calc(11px * var(--fs-scale-caption, 1))',
                          fontWeight: 700,
                          flexShrink: 0,
                          overflow: 'hidden',
                        }}
                      >
                        {msg.avatar ? (
                          <img
                            src={avatarSrc(msg.avatar)!}
                            alt=""
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          />
                        ) : (
                          (msg.username || '?')[0].toUpperCase()
                        )}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                          <span
                            className="text-[#111827]"
                            style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontWeight: 600 }}
                          >
                            {msg.username}
                          </span>
                          <span
                            className="text-[#9ca3af]"
                            style={{ fontSize: 'calc(10px * var(--fs-scale-caption, 1))' }}
                          >
                            {new Date(msg.created_at).toLocaleTimeString(locale, {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                        <div
                          className="text-[#374151]"
                          style={{
                            fontSize: 'calc(13px * var(--fs-scale-body, 1))',
                            marginTop: 3,
                            lineHeight: 1.5,
                            whiteSpace: 'pre-wrap',
                          }}
                        >
                          {msg.text}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{ textAlign: 'center', padding: '40px 0 20px' }}>
          <div
            className="border border-edge-faint bg-surface-card"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 16px',
              borderRadius: 20,
              boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
            }}
          >
            <img src="/icons/icon.svg" alt="TREK" width="18" height="18" style={{ borderRadius: 4 }} />
            <span className="text-[#9ca3af]" style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))' }}>
              {t('shared.sharedVia')} <strong className="text-[#6b7280]">TREK</strong>
            </span>
          </div>
          <div className="text-[#d1d5db]" style={{ marginTop: 8, fontSize: 'calc(10px * var(--fs-scale-caption, 1))' }}>
            Made with <span className="text-[#ef4444]">&hearts;</span> by Maurice ·{' '}
            <a href="https://github.com/liketrek/TREK" className="text-[#9ca3af]" style={{ textDecoration: 'none' }}>
              GitHub
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
