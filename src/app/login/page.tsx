import Image from "next/image";
import { LoginForm } from "./LoginForm";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center gap-3">
        <div className="rounded-[16px] bg-ink p-2">
          <Image src="/logo.png" alt="DLV Logistics" width={72} height={72} priority />
        </div>
        <div>
          <div className="flex items-center gap-2 text-[24px] font-bold">DLV <span className="h-2.5 w-2.5 rounded-full bg-neon" aria-hidden /></div>
          <div className="text-[13px] text-muted">Mitrex shipping portal</div>
        </div>
      </div>
      <LoginForm initialError={error ? "That sign-in link is invalid or expired. Request a new one, or use a code." : null} />
    </main>
  );
}
