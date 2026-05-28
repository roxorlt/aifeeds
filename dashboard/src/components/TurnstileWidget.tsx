import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { TURNSTILE_SITE_KEY, loadTurnstileScript, turnstileErrorMessage } from '../lib/turnstile';

export interface TurnstileWidgetHandle {
  reset: () => void;
}

interface TurnstileWidgetProps {
  onToken: (token: string) => void;
  onError?: (message: string) => void;
  onExpire?: () => void;
  className?: string;
}

// 可复用 Turnstile widget。render / reset / remove 生命周期自管理，
// 通过 ref 暴露 reset() 供父级在提交失败后刷新挑战。移动端兼容参数同 LoginModal
// （flexible 渲染更稳 / auto retry / 过期自动刷新）。
export const TurnstileWidget = forwardRef<TurnstileWidgetHandle, TurnstileWidgetProps>(
  function TurnstileWidget({ onToken, onError, onExpire, className }, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const widgetIdRef = useRef<string | null>(null);

    // 回调存 ref，render effect 只跑一次（不随回调身份变化重建 widget）
    const cbRef = useRef({ onToken, onError, onExpire });
    cbRef.current = { onToken, onError, onExpire };

    useImperativeHandle(
      ref,
      () => ({
        reset() {
          if (widgetIdRef.current && window.turnstile) {
            try {
              window.turnstile.reset(widgetIdRef.current);
            } catch {
              // widget 已失效（如已 remove）— 忽略
            }
          }
        },
      }),
      [],
    );

    useEffect(() => {
      let cancelled = false;
      let createdId: string | null = null;
      (async () => {
        try {
          await loadTurnstileScript();
          if (cancelled || !containerRef.current || !window.turnstile) return;
          const id = window.turnstile.render(containerRef.current, {
            sitekey: TURNSTILE_SITE_KEY,
            theme: 'auto',
            size: 'flexible',
            retry: 'auto',
            'retry-interval': 8000,
            'refresh-expired': 'auto',
            callback: (token: string) => cbRef.current.onToken(token),
            'error-callback': (code?: string) => cbRef.current.onError?.(turnstileErrorMessage(code)),
            'expired-callback': () => cbRef.current.onExpire?.(),
          });
          createdId = id;
          widgetIdRef.current = id;
        } catch (e) {
          cbRef.current.onError?.(`人机校验加载失败：${e instanceof Error ? e.message : String(e)}`);
        }
      })();
      return () => {
        cancelled = true;
        if (createdId && window.turnstile) {
          try {
            window.turnstile.remove(createdId);
          } catch {
            // 已移除 — 忽略
          }
        }
        widgetIdRef.current = null;
      };
    }, []);

    return <div ref={containerRef} className={className} />;
  },
);
