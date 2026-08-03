"use client";

import { useEffect, useRef, useState } from "react";
import type { InternalChatAttachment } from "./actions";

/**
 * Голосовые сообщения как в мессенджерах: запись с таймером и живой волной,
 * отмена без отправки, воспроизведение со своей дорожкой и перемоткой.
 *
 * Форму волны снимаем прямо во время записи (AnalyserNode) и сохраняем вместе
 * с сообщением — плеер потом рисует её без декодирования аудио, поэтому
 * выглядит одинаково во всех браузерах.
 */

const PEAK_COUNT = 48;
const MAX_SECONDS = 300;

function mmss(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Приводим снятые сэмплы к фиксированному числу столбиков. */
function resample(samples: number[], count: number): number[] {
  if (samples.length === 0) return new Array(count).fill(0.06);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * samples.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * samples.length) / count));
    let peak = 0;
    for (let j = from; j < to && j < samples.length; j++) peak = Math.max(peak, samples[j]);
    out.push(peak);
  }
  const max = Math.max(...out, 0.0001);
  // Нормируем к максимуму: тихая запись тоже должна читаться как волна.
  return out.map((v) => Math.max(0.06, Math.min(1, v / max)));
}

function Waveform({
  peaks,
  progress,
  onSeek,
}: {
  peaks: number[];
  progress: number;
  onSeek?: (ratio: number) => void;
}) {
  return (
    <div
      role={onSeek ? "slider" : undefined}
      aria-label={onSeek ? "Перемотка" : undefined}
      aria-valuenow={onSeek ? Math.round(progress * 100) : undefined}
      aria-valuemin={onSeek ? 0 : undefined}
      aria-valuemax={onSeek ? 100 : undefined}
      tabIndex={onSeek ? 0 : undefined}
      onClick={
        onSeek
          ? (e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              onSeek(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
            }
          : undefined
      }
      className={`flex h-8 min-w-0 flex-1 items-center gap-[2px] ${onSeek ? "cursor-pointer" : ""}`}
    >
      {peaks.map((p, i) => {
        const played = i / peaks.length < progress;
        return (
          <span
            key={i}
            className={`flex-1 rounded-pill transition-opacity ${played ? "opacity-100" : "opacity-40"}`}
            style={{ height: `${Math.round(p * 100)}%`, backgroundColor: "currentColor", minHeight: 2 }}
          />
        );
      })}
    </div>
  );
}

/** Плеер голосового сообщения внутри пузыря переписки. */
export function VoicePlayer({ attachment }: { attachment: InternalChatAttachment }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);

  const total = attachment.durationSec ?? 0;
  const peaks =
    attachment.peaks && attachment.peaks.length > 0
      ? attachment.peaks
      : new Array(PEAK_COUNT).fill(0.35);
  const progress = total > 0 ? Math.min(1, current / total) : 0;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrent(audio.currentTime);
    const onEnd = () => {
      setPlaying(false);
      setCurrent(0);
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("ended", onEnd);
    audio.addEventListener("pause", () => setPlaying(false));
    audio.addEventListener("play", () => setPlaying(true));
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("ended", onEnd);
    };
  }, []);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => setPlaying(false));
    else audio.pause();
  }

  return (
    <div className="flex min-w-[220px] items-center gap-2.5">
      <audio ref={audioRef} src={attachment.dataUrl} preload="metadata" className="hidden" />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Пауза" : "Воспроизвести"}
        className="flex h-9 w-9 flex-none items-center justify-center rounded-full border border-current text-xs opacity-90"
      >
        <span aria-hidden>{playing ? "❚❚" : "▶"}</span>
      </button>
      <Waveform
        peaks={peaks}
        progress={progress}
        onSeek={(ratio) => {
          const audio = audioRef.current;
          if (!audio || !total) return;
          audio.currentTime = ratio * total;
          setCurrent(ratio * total);
        }}
      />
      <span className="num flex-none text-2xs opacity-75">
        {mmss(playing || current > 0 ? total - current : total)}
      </span>
    </div>
  );
}

export interface RecordedVoice {
  dataUrl: string;
  mimeType: string;
  durationSec: number;
  peaks: number[];
}

function dataUrlFromBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Кнопка записи. В покое — микрофон; во время записи разворачивается в панель
 * с таймером, живой волной, отменой и отправкой. Отмена рвёт запись, ничего не
 * отправляя, — как в Telegram.
 */
export function VoiceRecorder({
  disabled,
  onRecorded,
  onError,
}: {
  disabled?: boolean;
  onRecorded: (voice: RecordedVoice) => void;
  onError: (message: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [live, setLive] = useState<number[]>([]);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const samplesRef = useRef<number[]>([]);
  const cancelledRef = useRef(false);
  const startedAtRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function cleanup() {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (tickRef.current !== null) clearInterval(tickRef.current);
    tickRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }

  // Страховка: уход со страницы во время записи не должен оставить включённый
  // микрофон и висящий AudioContext.
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      try {
        recorderRef.current?.stop();
      } catch {
        // ignore
      }
      cleanup();
    };
  }, []);

  async function start() {
    if (disabled || recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onError("Браузер не поддерживает запись голоса.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      onError("Нет доступа к микрофону.");
      return;
    }

    cancelledRef.current = false;
    chunksRef.current = [];
    samplesRef.current = [];
    setLive([]);
    setSeconds(0);
    startedAtRef.current = Date.now();

    // Живая волна: RMS с анализатора в каждом кадре.
    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const sample = () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        samplesRef.current.push(rms);
        setLive(resample(samplesRef.current, PEAK_COUNT));
        rafRef.current = requestAnimationFrame(sample);
      };
      rafRef.current = requestAnimationFrame(sample);
    } catch {
      // Без волны запись всё равно работает.
    }

    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      cleanup();
      setRecording(false);
      const cancelled = cancelledRef.current;
      const peaks = resample(samplesRef.current, PEAK_COUNT);
      const durationSec = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      chunksRef.current = [];
      samplesRef.current = [];
      if (cancelled || blob.size === 0) return;
      try {
        onRecorded({ dataUrl: await dataUrlFromBlob(blob), mimeType: blob.type, durationSec, peaks });
      } catch {
        onError("Не удалось подготовить голосовое сообщение.");
      }
    };
    recorder.start();
    setRecording(true);

    tickRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
      setSeconds(elapsed);
      if (elapsed >= MAX_SECONDS) stop();
    }, 250);
  }

  function stop() {
    try {
      recorderRef.current?.stop();
    } catch {
      setRecording(false);
    }
  }

  function cancel() {
    cancelledRef.current = true;
    stop();
  }

  if (!recording) {
    return (
      <button
        type="button"
        onClick={start}
        disabled={disabled}
        aria-label="Записать голосовое сообщение"
        title="Записать голосовое сообщение"
        className="border-border text-text-muted hover:bg-hover flex h-9 w-9 flex-none items-center justify-center rounded-full border text-base disabled:opacity-45"
      >
        <span aria-hidden>🎤</span>
      </button>
    );
  }

  return (
    <div className="border-accent-border bg-accent-tint text-accent-text flex min-w-0 flex-1 items-center gap-2.5 rounded-full border px-3 py-1.5">
      <span className="relative flex h-2.5 w-2.5 flex-none">
        <span className="bg-accent absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" />
        <span className="bg-accent relative inline-flex h-2.5 w-2.5 rounded-full" />
      </span>
      <span className="num flex-none text-xs">{mmss(seconds)}</span>
      <Waveform peaks={live.length ? live : new Array(PEAK_COUNT).fill(0.06)} progress={1} />
      <button
        type="button"
        onClick={cancel}
        aria-label="Отменить запись"
        title="Отменить запись"
        className="hover:text-text flex-none text-xs underline"
      >
        отмена
      </button>
      <button
        type="button"
        onClick={stop}
        aria-label="Отправить голосовое сообщение"
        title="Отправить"
        className="bg-accent text-accent-contrast hover:bg-accent-hover flex h-8 w-8 flex-none items-center justify-center rounded-full text-sm"
      >
        <span aria-hidden>↑</span>
      </button>
    </div>
  );
}
