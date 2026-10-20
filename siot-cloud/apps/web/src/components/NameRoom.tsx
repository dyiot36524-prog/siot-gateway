// 이름·위치 입력. 페어링 대기 중에도 쓸 수 있도록 저장 동작은 호출자가 정한다.
import { useState } from 'react';

export const ROOMS = ['거실', '안방', '작은방', '주방', '현관', '욕실', '베란다'];

export function NameRoomForm({
  initialName,
  initialRoom,
  onSave,
  saveLabel = '저장',
  compact = false,
}: {
  initialName: string;
  initialRoom: string | null;
  onSave(v: { name: string; room: string | null }): Promise<void> | void;
  saveLabel?: string;
  compact?: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [room, setRoom] = useState<string | null>(initialRoom);
  const [custom, setCustom] = useState(initialRoom && !ROOMS.includes(initialRoom) ? initialRoom : '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const save = async () => {
    setState('saving');
    try {
      await onSave({ name: name.trim(), room: room });
      setState('saved');
    } catch {
      setState('error');
    }
  };

  return (
    <div className={compact ? 'nameroom nameroom--compact' : 'nameroom'}>
      <label className="field">
        <span>이름</span>
        <input
          value={name}
          maxLength={100}
          placeholder="예: 거실 스탠드"
          onChange={(e) => {
            setName(e.target.value);
            setState('idle');
          }}
        />
      </label>
      <div className="field">
        <span>위치</span>
        <div className="chips" role="group" aria-label="위치">
          {ROOMS.map((r) => (
            <button
              key={r}
              type="button"
              className={room === r ? 'chip chip--on' : 'chip'}
              aria-pressed={room === r}
              onClick={() => {
                setRoom(room === r ? null : r);
                setState('idle');
              }}
            >
              {r}
            </button>
          ))}
          <input
            className="chip chip--input"
            placeholder="직접 입력"
            maxLength={50}
            value={custom}
            aria-label="위치 직접 입력"
            onChange={(e) => {
              setCustom(e.target.value);
              setRoom(e.target.value.trim() || null);
              setState('idle');
            }}
          />
        </div>
      </div>
      <div className="btnrow">
        <button type="button" className="btn btn--secondary" disabled={state === 'saving'} onClick={() => void save()}>
          {state === 'saving' ? '저장 중…' : saveLabel}
        </button>
        {state === 'saved' && <span className="small ok-text">저장됨</span>}
        {state === 'error' && <span className="small error">저장 실패 · 다시 누르세요</span>}
      </div>
    </div>
  );
}
