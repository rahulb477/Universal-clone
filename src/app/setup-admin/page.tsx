import Link from "next/link";
import SetupAdminForm from "@/components/SetupAdminForm";
import { publicSetupStatus } from "@/lib/server/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Set up the first administrator — Universal Clone",
  robots: { index: false, follow: false },
};

/**
 * /setup-admin — one-time first-administrator setup.
 *
 * The page is rendered on the server so the browser learns only whether setup is available; the
 * ADMIN_SETUP_KEY is read in the API route and is never sent to the client. The form is a thin
 * wrapper: every restriction is enforced again by POST /api/auth/setup.
 */
export default async function SetupAdminPage() {
  const status = await publicSetupStatus();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-slate-950 via-slate-900 to-slate-800 px-4 py-8 sm:py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Universal Clone</h1>
          <p className="mt-1 text-sm text-slate-400">First administrator setup</p>
        </div>

        <div className="rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-black/5 sm:p-7">
          {status.setupAvailable ? (
            <SetupAdminForm />
          ) : (
            <section aria-label="Setup unavailable" className="space-y-4">
              <h2 className="text-lg font-semibold text-slate-900">Setup is not available</h2>
              <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
                {status.message}
              </p>
              {status.state === "completed" ? (
                <p className="text-sm text-slate-600">First-administrator setup can only be used once. Sign in with the administrator account you created.</p>
              ) : status.state === "key-too-weak" ? (
                <p className="text-sm text-slate-600">
                  {`ADMIN_SETUP_KEY must be a randomly generated secret of at least 32 characters. Generate one with “openssl rand -base64 48” and set it in your hosting environment, then reload this page.`}
                </p>
              ) : (
                <p className="text-sm text-slate-600">
                  {`An operator must set ADMIN_SETUP_KEY (a random secret of at least 32 characters) in the deployment's environment variables before this page can be used.`}
                </p>
              )}
              <Link href="/" className="block w-full rounded-lg bg-slate-900 px-4 py-3 text-center font-semibold text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-400">
                Go to sign in
              </Link>
            </section>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-slate-500">
          {status.setupAvailable
            ? "Setup can be completed once. Afterwards it stays disabled permanently."
            : "Administrator accounts can also be created by an operator with the command-line tool."}
        </p>
        {status.setupAvailable && (
          <p className="mt-2 text-center text-xs">
            <Link href="/" className="text-slate-400 underline decoration-slate-600 hover:text-white">
              Back to sign in
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}
