import { useEffect, useRef, useState } from 'react';
import type { PetMood } from '@shared/types';

// =============================================================================
// PetWidget — the AI companion that lives in the bottom-right corner.
//
// State machine:
//   idle      → default, gently breathing animation
//   thinking  → spinner / waiting — AI is processing
//   working   → progress dots — tool call loop running
//   happy     → celebration — task succeeded
//   worried   → frown — Guardian triggered / error
//   sleepy    → yawn — user idle > 30min
//
// The widget reacts to:
//   - prop `mood` passed down from the chat panel (busy → thinking/working)
//   - idle timer: if no interaction for IDLE_MS it switches to 'sleepy'
//   - clicking the widget opens a tiny chat bubble with a random quip
// =============================================================================

const IDLE_MS = 30 * 60 * 1000; // 30 minutes

const EMOJI: Record<PetMood, string> = {
  idle: '🤖',
  thinking: '🧠',
  working: '⚙️',
  happy: '🎉',
  worried: '😟',
  sleepy: '😴',
};

const QUIPS: Record<PetMood, string[]> = {
  idle: [
    '随时叫我！',
    '我在等你的指令~',
    '有啥想做的？',
    '代码写得怎么样？',
    '记得休息！',
  ],
  thinking: [
    '让我想想…',
    '正在理解你的意图…',
    '稍等，处理中…',
  ],
  working: [
    '动起来了！',
    '工具调用中…',
    '在帮你搞定…',
    '别眨眼！',
  ],
  happy: [
    '搞定了！🎉',
    '完美执行~',
    '你真厉害，搭档！',
    '任务完成！',
  ],
  worried: [
    '等等，这样不行…',
    '我需要你确认一下',
    '碰到受保护的文件了！',
    '出了点问题…',
  ],
  sleepy: [
    '你还在吗？😴',
    '休息一下吧~',
    '我也困了…zzz',
    '工作了很久了！喝口水？',
  ],
};

function randomQuip(mood: PetMood): string {
  const list = QUIPS[mood];
  return list[Math.floor(Math.random() * list.length)];
}

interface Props {
  mood: PetMood;
  onChatOpen?: () => void;
}

export function PetWidget({ mood, onChatOpen }: Props): JSX.Element {
  const [bubble, setBubble] = useState<string | null>(null);
  const [localMood, setLocalMood] = useState<PetMood>(mood);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync mood from parent (AI state) but don't override sleepy when idle.
  useEffect(() => {
    if (localMood !== 'sleepy') {
      setLocalMood(mood);
    } else if (mood !== 'idle') {
      // If AI wakes up while we're sleepy, wake the pet too.
      setLocalMood(mood);
    }
  }, [mood, localMood]);

  // Idle detection: reset on any user interaction.
  useEffect(() => {
    function resetIdle() {
      if (localMood === 'sleepy') setLocalMood('idle');
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => {
        setLocalMood('sleepy');
      }, IDLE_MS);
    }
    window.addEventListener('mousemove', resetIdle);
    window.addEventListener('keydown', resetIdle);
    resetIdle();
    return () => {
      window.removeEventListener('mousemove', resetIdle);
      window.removeEventListener('keydown', resetIdle);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Show quip bubble for 3 seconds.
  function showBubble() {
    const quip = randomQuip(localMood);
    setBubble(quip);
    if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
    bubbleTimer.current = setTimeout(() => setBubble(null), 3000);
  }

  function handleClick() {
    showBubble();
    onChatOpen?.();
  }

  const animClass = {
    idle: 'pet-idle',
    thinking: 'pet-thinking',
    working: 'pet-working',
    happy: 'pet-happy',
    worried: 'pet-worried',
    sleepy: 'pet-sleepy',
  }[localMood];

  return (
    <div className="pet-widget-wrap">
      {bubble && (
        <div className="pet-bubble">
          {bubble}
        </div>
      )}
      <button
        className={`pet-widget ${animClass}`}
        onClick={handleClick}
        title={`AI 伙伴 — ${localMood}`}
        aria-label="AI 伙伴"
      >
        <span className="pet-emoji">{EMOJI[localMood]}</span>
      </button>
    </div>
  );
}
