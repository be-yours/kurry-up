// BOILERPLATE FILE (does not exist in the engine — never overwritten by the
// resync). Routes in the (test) group are Playwright harnesses
// (e.g. /address-test): useful in dev and e2e (the `pnpm dev` server), but
// they have no business being on a client site in production.
// An engine issue is open to adopt this guard upstream.
import { notFound } from "next/navigation";

export default function TestRoutesLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_PUBLIC_ENABLE_TEST_ROUTES !== "true"
  ) {
    notFound();
  }
  return children;
}
