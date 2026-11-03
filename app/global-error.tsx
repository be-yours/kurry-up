"use client";

/**
 * Last resort: an error thrown by the root layout itself.
 *
 * This boundary replaces the layout, so it renders its own `<html>` and
 * `<body>` and imports the stylesheet directly — nothing above it runs.
 * Rare, and the most expensive kind of failure: the whole site is down, for
 * everyone, and no other boundary will report it.
 */

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import "./globals.css";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="fr">
      <body className="antialiased">
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
          <h1 className="text-2xl font-semibold">Le site est momentanément indisponible</h1>
          <p className="max-w-md text-sm opacity-70">
            Une erreur inattendue empêche l&apos;affichage. L&apos;incident a été signalé
            automatiquement.
          </p>
          {error.digest && (
            <p className="font-mono text-xs opacity-70">Référence : {error.digest}</p>
          )}
          {/*
            A full reload, not a `next/link`: the root layout is what failed,
            so a soft navigation would re-mount the same broken tree. This
            throws the whole client state away and starts over.
          */}
          <button
            type="button"
            onClick={() => window.location.assign("/")}
            className="mt-2 rounded-md border px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90"
          >
            Retour à l&apos;accueil
          </button>
        </div>
      </body>
    </html>
  );
}
