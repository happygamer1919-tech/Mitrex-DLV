"use client";

// DLV-043 STAFF-03: the last safety net. Without it Next showed its own "This page couldn't load" page in place of
// the whole app. The forms catch their own failures; this only shows when something else breaks while rendering.
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto max-w-xl p-6">
      <div role="alert" data-testid="app-error" className="rounded-[16px] border border-line bg-white p-5">
        <h1 className="text-[20px] font-bold">Something went wrong.</h1>
        <p className="mt-2 text-[15px]">Reload the page. If it happens again, call DLV dispatch.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={() => window.location.reload()}
            className="inline-flex min-h-[44px] cursor-pointer items-center rounded-full bg-ink px-5 text-[15px] font-bold text-white">
            Reload
          </button>
          <button type="button" onClick={() => reset()}
            className="inline-flex min-h-[44px] cursor-pointer items-center rounded-full border border-line px-5 text-[15px] font-bold">
            Try again
          </button>
        </div>
      </div>
    </main>
  );
}
