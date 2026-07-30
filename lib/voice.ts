"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { synthesizeSpeech } from "@/app/(dashboard)/_components/voice-actions";
// useState/useEffect/useRef/useCallback используются ниже в useVoice.

/**
 * Голос ассистента: распознавание (микрофон → текст, режим «зажать и говорить»)
 * и синтез. Синтез — нейросетевой TTS через routerai (живой голос); если он
 * недоступен, откатываемся на системный Web Speech. speak() возвращает промис,
 * завершающийся по концу озвучки — на этом строится режим «звонка».
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type SpeechRecognitionLike = any;
function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Режем текст на фрагменты по границам предложений (≤ maxLen), чтобы TTS не обрывался. */
function chunkText(text: string, maxLen = 380): string[] {
  const sentences = text.replace(/\s+/g, " ").split(/(?<=[.!?…])\s+/);
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + " " + s).length > maxLen) {
      chunks.push(cur.trim());
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  // Одно слишком длинное предложение — доразбиваем по длине.
  return chunks.flatMap((c) => (c.length <= maxLen ? [c] : (c.match(new RegExp(`.{1,${maxLen}}`, "g")) ?? [c])));
}

export interface VoiceApi {
  recognitionSupported: boolean;
  listening: boolean;
  interimText: string;
  speaking: boolean;
  startListening: (onFinal: (text: string) => void, opts?: { continuous?: boolean }) => void;
  stopListening: () => void;
  speak: (text: string) => Promise<void>;
  cancelSpeak: () => void;
}

export function useVoice(): VoiceApi {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interimText, setInterimText] = useState("");

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef("");
  const onFinalRef = useRef<((t: string) => void) | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const speakSession = useRef(0);

  // Поддержку API определяем ПОСЛЕ монтирования — на сервере window нет, и без
  // этого SSR (false) расходится с клиентом (true) и ломает гидрацию.
  const [support, setSupport] = useState({ rec: false, syn: false });
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      setSupport({ rec: getRecognitionCtor() !== null, syn: typeof window !== "undefined" && "speechSynthesis" in window }),
    );
    return () => cancelAnimationFrame(id);
  }, []);
  const recognitionSupported = support.rec;
  const hasSynthesis = () => typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => {
    return () => {
      try {
        recRef.current?.stop?.();
        audioRef.current?.pause();
        if (hasSynthesis()) window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    };
  }, []);

  const startListening = useCallback(
    (onFinal: (text: string) => void, opts?: { continuous?: boolean }) => {
      const Ctor = getRecognitionCtor();
      if (!Ctor) return;
      try {
        recRef.current?.stop?.();
      } catch {
        // ignore
      }
      const rec = new Ctor();
      rec.lang = "ru-RU";
      rec.interimResults = true;
      rec.continuous = opts?.continuous ?? false;
      rec.maxAlternatives = 1;
      finalRef.current = "";
      onFinalRef.current = onFinal;
      setInterimText("");
      rec.onresult = (e: {
        resultIndex: number;
        results: { length: number; [i: number]: { isFinal: boolean; [j: number]: { transcript: string } } };
      }) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalRef.current += r[0].transcript;
          else interim += r[0].transcript;
        }
        setInterimText((finalRef.current + interim).trim());
      };
      rec.onend = () => {
        setListening(false);
        const text = finalRef.current.trim();
        setInterimText("");
        if (text && onFinalRef.current) onFinalRef.current(text);
      };
      rec.onerror = () => setListening(false);
      recRef.current = rec;
      setListening(true);
      try {
        rec.start();
      } catch {
        setListening(false);
      }
    },
    [],
  );

  const stopListening = useCallback(() => {
    try {
      recRef.current?.stop?.();
    } catch {
      setListening(false);
    }
  }, []);

  const cancelSpeak = useCallback(() => {
    speakSession.current += 1; // прерываем текущую очередь озвучки
    try {
      audioRef.current?.pause();
      audioRef.current = null;
      if (hasSynthesis()) window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
    setSpeaking(false);
  }, []);

  const playBase64 = useCallback((audioBase64: string, mime: string, session: number) => {
    return new Promise<void>((resolve) => {
      if (speakSession.current !== session) return resolve();
      const audio = new Audio(`data:${mime};base64,${audioBase64}`);
      audioRef.current = audio;
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      void audio.play().catch(() => resolve());
    });
  }, []);

  const speakWeb = useCallback((text: string) => {
    return new Promise<void>((resolve) => {
      if (!hasSynthesis()) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ru-RU";
      u.rate = 1.02;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
  }, []);

  const speak = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean) return;
      cancelSpeak();
      const session = speakSession.current;
      setSpeaking(true);

      // Длинный ответ режем на фрагменты по предложениям, иначе TTS обрывается.
      const chunks = chunkText(clean);
      // Пайплайн: пока играет текущий фрагмент, синтезируем следующий.
      let next: Promise<{ audioBase64: string | null; mime: string }> | null =
        chunks.length ? synthesizeSpeech(chunks[0]) : null;

      for (let i = 0; i < chunks.length; i++) {
        if (speakSession.current !== session) break;
        const res = await next;
        next = i + 1 < chunks.length ? synthesizeSpeech(chunks[i + 1]) : null;
        if (speakSession.current !== session) break;
        if (res?.audioBase64) await playBase64(res.audioBase64, res.mime, session);
        else await speakWeb(chunks[i]);
      }

      if (speakSession.current === session) setSpeaking(false);
    },
    [cancelSpeak, playBase64, speakWeb],
  );

  return {
    recognitionSupported,
    listening,
    interimText,
    speaking,
    startListening,
    stopListening,
    speak,
    cancelSpeak,
  };
}
