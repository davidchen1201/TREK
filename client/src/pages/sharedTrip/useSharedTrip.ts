import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { shareApi } from '../../api/client';
import { useExchangeRates } from '../../hooks/useExchangeRates';

type DayNotePatch = {
  text?: string;
  time?: string | null;
  icon?: string | null;
  sort_order?: number;
  color?: string | null;
};

/** Public-share data and token-scoped editing actions. Each mutation updates the
 * snapshot only after the request succeeds, keeping the editor's draft intact
 * when a guest loses connectivity or its edit permission is revoked. */
export function useSharedTrip() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState(false);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [initialDaySelected, setInitialDaySelected] = useState(false);
  const [activeTab, setActiveTab] = useState('plan');
  const [showLangPicker, setShowLangPicker] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setData(null);
    setError(false);
    setSelectedDay(null);
    setInitialDaySelected(false);
    shareApi
      .getSharedTrip(token)
      .then((snapshot) => {
        if (!cancelled) setData(snapshot);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (data?.days?.length && !initialDaySelected) {
      setSelectedDay([...data.days].sort((a: any, b: any) => a.day_number - b.day_number)[0].id);
      setInitialDaySelected(true);
    }
  }, [data, initialDaySelected]);

  useEffect(() => {
    if (!data) return;
    const p = data.permissions || {};
    if (p.share_map === false && activeTab === 'plan') {
      setActiveTab(
        p.share_bookings
          ? 'bookings'
          : p.share_packing
            ? 'packing'
            : p.share_budget
              ? 'budget'
              : p.share_collab
                ? 'collab'
                : 'plan'
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const updateDay = async (dayId: number, title: string) => {
    if (!token) throw new Error('Missing share token');
    await shareApi.updateSharedDay(token, dayId, title);
    setData((current: any) => ({
      ...current,
      days: current.days.map((day: any) => (day.id === dayId ? { ...day, title } : day)),
    }));
  };

  const createDayNote = async (dayId: number, fields: Required<Pick<DayNotePatch, 'text'>> & DayNotePatch) => {
    if (!token) throw new Error('Missing share token');
    const result = await shareApi.createSharedDayNote(token, dayId, fields);
    const note = result?.note ?? result;
    if (!note?.id) throw new Error('Invalid note response');
    setData((current: any) => ({
      ...current,
      dayNotes: { ...current.dayNotes, [String(dayId)]: [...(current.dayNotes?.[String(dayId)] || []), note] },
    }));
    return note;
  };

  const updateDayNote = async (dayId: number, noteId: number, patch: DayNotePatch) => {
    if (!token) throw new Error('Missing share token');
    const result = await shareApi.updateSharedDayNote(token, dayId, noteId, patch);
    const note = result?.note ?? result;
    setData((current: any) => ({
      ...current,
      dayNotes: {
        ...current.dayNotes,
        [String(dayId)]: (current.dayNotes?.[String(dayId)] || []).map((item: any) =>
          item.id === noteId ? { ...item, ...patch, ...(note?.id ? note : {}) } : item
        ),
      },
    }));
  };

  const deleteDayNote = async (dayId: number, noteId: number) => {
    if (!token) throw new Error('Missing share token');
    await shareApi.deleteSharedDayNote(token, dayId, noteId);
    setData((current: any) => ({
      ...current,
      dayNotes: {
        ...current.dayNotes,
        [String(dayId)]: (current.dayNotes?.[String(dayId)] || []).filter((item: any) => item.id !== noteId),
      },
    }));
  };

  const base = String(data?.baseCurrency || data?.trip?.currency || 'EUR').toUpperCase();
  const { convert } = useExchangeRates(base);

  return {
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
    editable: data?.permissions?.share_edit === true,
    updateDay,
    createDayNote,
    updateDayNote,
    deleteDayNote,
  };
}
