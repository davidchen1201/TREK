import { Check, ChevronDown, Clock3, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import Markdown from 'react-markdown';
import { sanitizedMarkdownComponents, sanitizedMarkdownPlugins } from '../../components/shared/markdownSanitize';

type Day = { id: number; title?: string | null; day_number?: number };
type Note = {
  id: number;
  text: string;
  time?: string | null;
  icon?: string | null;
  sort_order?: number;
  color?: string | null;
};

type Copy = {
  edit: string;
  save: string;
  cancel: string;
  add: string;
  delete: string;
  titlePlaceholder: string;
  itemPlaceholder: string;
  timePlaceholder: string;
  saveFailed: string;
  addFailed: string;
  deleteFailed: string;
};

function copyFor(locale: string): Copy {
  const zh = locale.toLowerCase().startsWith('zh');
  return zh
    ? {
        edit: '编辑',
        save: '保存',
        cancel: '取消',
        add: '添加行程',
        delete: '删除',
        titlePlaceholder: '当天标题',
        itemPlaceholder: '地点或活动｜说明',
        timePlaceholder: '时间',
        saveFailed: '未能保存，内容已保留。',
        addFailed: '未能添加，内容已保留。',
        deleteFailed: '未能删除，请重试。',
      }
    : {
        edit: 'Edit',
        save: 'Save',
        cancel: 'Cancel',
        add: 'Add item',
        delete: 'Delete',
        titlePlaceholder: 'Day title',
        itemPlaceholder: 'Place or activity | details',
        timePlaceholder: 'Time',
        saveFailed: 'Could not save. Your changes are still here.',
        addFailed: 'Could not add this item. Your draft is still here.',
        deleteFailed: 'Could not delete this item. Please try again.',
      };
}

function stripChecklist(text: string) {
  const match = text.match(/^\[(x| )\]\s*/i);
  return { done: match?.[1]?.toLowerCase() === 'x', content: text.replace(/^\[(?:x| )\]\s*/i, '') };
}

function buttonStyle(kind: 'quiet' | 'primary' | 'danger' = 'quiet') {
  const colors =
    kind === 'primary'
      ? { color: '#fff', background: '#111827', border: '#111827' }
      : kind === 'danger'
        ? { color: '#b42318', background: '#fff7f7', border: '#fecaca' }
        : { color: '#475569', background: '#fff', border: '#dbe3ee' };
  return {
    ...colors,
    border: `1px solid ${colors.border}`,
    borderRadius: 9,
    padding: '7px 10px',
    fontFamily: 'inherit',
    fontWeight: 650,
    fontSize: '14px',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
  } as const;
}

export function EditableDayTitle({
  day,
  editable,
  locale,
  onSave,
}: {
  day: Day;
  editable: boolean;
  locale: string;
  onSave: (title: string) => Promise<unknown>;
}) {
  const copy = copyFor(locale);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(day.title || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const cancel = () => {
    setTitle(day.title || '');
    setError('');
    setEditing(false);
  };
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await onSave(title.trim());
      setEditing(false);
    } catch {
      setError(copy.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
        <div
          style={{
            minWidth: 0,
            flex: 1,
            fontSize: '17px',
            lineHeight: 1.5,
            fontWeight: 760,
            color: '#172033',
            overflowWrap: 'anywhere',
          }}
        >
          {day.title ||
            `${locale.toLowerCase().startsWith('zh') ? '第' : 'Day '}${day.day_number || ''}${locale.toLowerCase().startsWith('zh') ? '天' : ''}`}
        </div>
        {editable && (
          <button
            type="button"
            aria-label={copy.edit}
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
            style={{ ...buttonStyle(), padding: 5, flexShrink: 0 }}
          >
            <Pencil size={13} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div onClick={(e) => e.stopPropagation()} style={{ minWidth: 0, flex: 1 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          aria-label={copy.titlePlaceholder}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={copy.titlePlaceholder}
          autoFocus
          style={{
            minWidth: 0,
            flex: 1,
            border: '1px solid #94a3b8',
            borderRadius: 8,
            padding: '8px 9px',
            font: '650 16px inherit',
            color: '#172033',
          }}
        />
        <button
          type="button"
          aria-label={copy.save}
          disabled={saving}
          onClick={save}
          style={{ ...buttonStyle('primary'), padding: 7 }}
        >
          <Check size={14} />
        </button>
        <button
          type="button"
          aria-label={copy.cancel}
          disabled={saving}
          onClick={cancel}
          style={{ ...buttonStyle(), padding: 7 }}
        >
          <X size={14} />
        </button>
      </div>
      {error && (
        <div role="alert" style={{ color: '#b42318', fontSize: 13, marginTop: 5 }}>
          {error}
        </div>
      )}
    </div>
  );
}

export function EditableSharedNote({
  note,
  editable,
  locale,
  onSave,
  onDelete,
}: {
  note: Note;
  editable: boolean;
  locale: string;
  onSave: (patch: Partial<Note>) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}) {
  const copy = copyFor(locale);
  const initial = stripChecklist(note.text || '');
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(initial.content);
  const [time, setTime] = useState(note.time || '');
  const [done, setDone] = useState(initial.done);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const visible = stripChecklist(note.text || '');

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await onSave({ text: `${done ? '[x]' : '[ ]'} ${text.trim()}`, time: time.trim() || null });
      setEditing(false);
    } catch {
      setError(copy.saveFailed);
    } finally {
      setSaving(false);
    }
  };
  const toggle = async () => {
    setSaving(true);
    setError('');
    const next = !visible.done;
    try {
      await onSave({ text: `${next ? '[x]' : '[ ]'} ${visible.content}` });
    } catch {
      setError(copy.saveFailed);
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(`${copy.delete}?`)) return;
    setSaving(true);
    setError('');
    try {
      await onDelete();
    } catch {
      setError(copy.deleteFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '14px 14px 14px 10px',
        borderRadius: 13,
        background: note.color || '#f8fafc',
        border: '1px solid #e3eaf3',
        boxShadow: '0 2px 7px rgba(15,23,42,.035)',
      }}
    >
      <div
        style={{
          width: 62,
          flex: '0 0 62px',
          paddingTop: 2,
          color: '#64748b',
          fontSize: 13,
          fontWeight: 750,
          letterSpacing: '.01em',
        }}
      >
        {note.time || '—'}
      </div>
      {editable ? (
        <button
          type="button"
          aria-label={visible.done ? 'Mark incomplete' : 'Mark complete'}
          onClick={toggle}
          disabled={saving}
          style={{
            width: 22,
            height: 22,
            marginTop: 1,
            borderRadius: 7,
            border: `2px solid ${visible.done ? '#0f766e' : '#94a3b8'}`,
            color: '#fff',
            background: visible.done ? '#0f766e' : '#fff',
            cursor: 'pointer',
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
          }}
        >
          {visible.done && <Check size={14} strokeWidth={3} />}
        </button>
      ) : visible.done ? (
        <Check size={18} color="#0f766e" style={{ marginTop: 2, flexShrink: 0 }} />
      ) : (
        <Clock3 size={18} color="#64748b" style={{ marginTop: 2, flexShrink: 0 }} />
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        {editing ? (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                aria-label={copy.timePlaceholder}
                value={time}
                onChange={(e) => setTime(e.target.value)}
                placeholder="09:00"
                style={{
                  width: 86,
                  border: '1px solid #94a3b8',
                  borderRadius: 8,
                  padding: '8px',
                  font: '14px inherit',
                }}
              />
              <textarea
                aria-label={copy.itemPlaceholder}
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                style={{
                  minWidth: 0,
                  flex: '1 1 150px',
                  border: '1px solid #94a3b8',
                  borderRadius: 8,
                  padding: '8px',
                  font: '15px inherit',
                  resize: 'vertical',
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
              <button type="button" disabled={saving} onClick={save} style={buttonStyle('primary')}>
                <Check size={14} />
                {copy.save}
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setText(visible.content);
                  setTime(note.time || '');
                  setDone(visible.done);
                  setEditing(false);
                  setError('');
                }}
                style={buttonStyle()}
              >
                {copy.cancel}
              </button>
            </div>
          </>
        ) : (
          <div
            style={{
              fontSize: 16,
              lineHeight: 1.55,
              color: visible.done ? '#64748b' : '#1e293b',
              textDecoration: visible.done ? 'line-through' : 'none',
              overflowWrap: 'anywhere',
            }}
          >
            <Markdown
              rehypePlugins={sanitizedMarkdownPlugins}
              components={{
                ...sanitizedMarkdownComponents,
                a: ({ children, href }) => (
                  <a href={href} target={href?.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer nofollow"
                    style={{ color: '#0f766e', textDecoration: 'underline', textUnderlineOffset: 3 }}>
                    {children}
                  </a>
                ),
                p: ({ children }) => <p style={{ margin: '0 0 6px', whiteSpace: 'pre-wrap' }}>{children}</p>,
                img: () => null,
              }}
            >
              {visible.content}
            </Markdown>
          </div>
        )}
        {error && (
          <div role="alert" style={{ color: '#b42318', fontSize: 13, marginTop: 7 }}>
            {error}
          </div>
        )}
      </div>
      {editable && !editing && (
        <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
          <button
            type="button"
            aria-label={copy.edit}
            onClick={() => {
              setText(visible.content);
              setTime(note.time || '');
              setDone(visible.done);
              setEditing(true);
            }}
            style={{ ...buttonStyle(), padding: 6 }}
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            aria-label={copy.delete}
            onClick={remove}
            disabled={saving}
            style={{ ...buttonStyle('danger'), padding: 6 }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

export function AddSharedNote({
  locale,
  onAdd,
}: {
  locale: string;
  onAdd: (text: string, time: string) => Promise<unknown>;
}) {
  const copy = copyFor(locale);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [time, setTime] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (!text.trim()) return;
    setSaving(true);
    setError('');
    try {
      await onAdd(text.trim(), time.trim());
      setText('');
      setTime('');
      setOpen(false);
    } catch {
      setError(copy.addFailed);
    } finally {
      setSaving(false);
    }
  };
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          ...buttonStyle(),
          width: '100%',
          justifyContent: 'center',
          borderStyle: 'dashed',
          color: '#334155',
          background: '#f8fafc',
        }}
      >
        <Plus size={16} />
        {copy.add}
      </button>
    );
  return (
    <div style={{ padding: 12, borderRadius: 12, border: '1px dashed #94a3b8', background: '#f8fafc' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          aria-label={copy.timePlaceholder}
          value={time}
          onChange={(e) => setTime(e.target.value)}
          placeholder="09:00"
          style={{ width: 86, border: '1px solid #94a3b8', borderRadius: 8, padding: '9px', font: '14px inherit' }}
        />
        <input
          aria-label={copy.itemPlaceholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={copy.itemPlaceholder}
          autoFocus
          style={{
            minWidth: 0,
            flex: '1 1 150px',
            border: '1px solid #94a3b8',
            borderRadius: 8,
            padding: '9px',
            font: '15px inherit',
          }}
        />
      </div>
      <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
        <button type="button" disabled={saving || !text.trim()} onClick={save} style={buttonStyle('primary')}>
          <Check size={14} />
          {copy.save}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            setOpen(false);
            setError('');
          }}
          style={buttonStyle()}
        >
          {copy.cancel}
        </button>
      </div>
      {error && (
        <div role="alert" style={{ color: '#b42318', fontSize: 13, marginTop: 7 }}>
          {error}
        </div>
      )}
    </div>
  );
}

export function DayChevron({ open }: { open: boolean }) {
  return (
    <ChevronDown
      size={19}
      style={{
        color: '#64748b',
        transform: open ? 'rotate(180deg)' : undefined,
        transition: 'transform .16s',
        flexShrink: 0,
      }}
    />
  );
}
