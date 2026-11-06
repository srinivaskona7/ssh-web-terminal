import { useEffect, useRef } from 'preact/hooks';

/**
 * Cloudflare Turnstile widget. The challenge is validated server-side by the
 * relay; this only supplies the token. The script is the one third-party
 * resource in the product and is loaded only when a site key is configured.
 */
interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string | number;
  reset: (widgetId: string | number) => void;
  remove: (widgetId: string | number) => void;
}

function getTurnstileApi(): TurnstileApi | undefined {
  return (globalThis as unknown as { turnstile?: TurnstileApi }).turnstile;
}

export function TurnstileWidget({
  siteKey,
  resetNonce,
  onToken
}: {
  siteKey: string;
  resetNonce: number;
  onToken: (token: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | number | null>(null);
  // Callbacks are read through a ref so a parent re-render never re-renders
  // the widget or leaves the challenge bound to a stale callback.
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    let cancelled = false;
    const renderWidget = (): void => {
      const turnstile = getTurnstileApi();
      if (cancelled || !ref.current || !turnstile || widgetIdRef.current !== null) return;
      widgetIdRef.current = turnstile.render(ref.current, {
        sitekey: siteKey,
        action: 'ssh_connect',
        callback: (token: string) => onTokenRef.current(token),
        'expired-callback': () => onTokenRef.current(''),
        'error-callback': () => onTokenRef.current('')
      });
    };
    // The API may already be present from an earlier mount or another widget;
    // render now rather than waiting for a load event that will not fire again.
    if (getTurnstileApi()) {
      renderWidget();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-webssh-turnstile]'
    );
    if (existing) {
      // The tag is present but the API has not loaded yet; wait for it rather
      // than silently rendering nothing.
      existing.addEventListener('load', renderWidget);
      return () => existing.removeEventListener('load', renderWidget);
    }
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.dataset.websshTurnstile = '1';
    script.addEventListener('load', renderWidget);
    document.head.appendChild(script);
    return () => {
      cancelled = true;
      script.removeEventListener('load', renderWidget);
    };
  }, [siteKey]);

  // A Turnstile response is single-use, so the parent bumps this after every
  // ticket attempt to put a fresh challenge in front of the user.
  useEffect(() => {
    if (resetNonce === 0) return;
    const turnstile = getTurnstileApi();
    if (turnstile && widgetIdRef.current !== null) turnstile.reset(widgetIdRef.current);
  }, [resetNonce]);

  useEffect(
    () => () => {
      const turnstile = getTurnstileApi();
      if (turnstile && widgetIdRef.current !== null) {
        turnstile.remove(widgetIdRef.current);
      }
      widgetIdRef.current = null;
    },
    []
  );

  return <div ref={ref} data-testid="turnstile-widget" />;
}
