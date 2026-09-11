import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EditableSharedNote } from './SharedItineraryEditor';

const note = { id: 9, text: '[ ] 大皇宫｜上午参观', time: '09:00', icon: '📝', sort_order: 1, color: null };

describe('EditableSharedNote', () => {
  it('persists a checklist toggle in the compact note format', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EditableSharedNote note={note} editable locale="zh-CN" onSave={onSave} onDelete={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Mark complete' }));
    expect(onSave).toHaveBeenCalledWith({ text: '[x] 大皇宫｜上午参观' });
  });

  it('cancels an edit without persisting the draft', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EditableSharedNote note={note} editable locale="zh-CN" onSave={onSave} onDelete={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '编辑' }));
    await user.clear(screen.getByLabelText('地点或活动｜说明'));
    await user.type(screen.getByLabelText('地点或活动｜说明'), '临时草稿');
    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('大皇宫｜上午参观')).toBeInTheDocument();
  });

  it('keeps the draft visible when saving fails', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new Error('offline'));
    render(<EditableSharedNote note={note} editable locale="zh-CN" onSave={onSave} onDelete={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '编辑' }));
    await user.clear(screen.getByLabelText('地点或活动｜说明'));
    await user.type(screen.getByLabelText('地点或活动｜说明'), '连接失败也保留');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('未能保存，内容已保留。');
    expect(screen.getByDisplayValue('连接失败也保留')).toBeInTheDocument();
  });
});
