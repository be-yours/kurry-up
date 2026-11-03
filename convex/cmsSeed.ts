"use node";

/**
 * CMS Seed — Downloads images to S3 and populates all CMS pages.
 *
 * Run via Convex dashboard or: npx convex run cmsSeed:seedCmsContent
 */

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type { Id } from "./_generated/dataModel";
import { buildMediaUrl } from "@be-yours/core/aws/media-url";

// ── S3 helpers ───────────────────────────────────────────────────────

function createS3Client() {
  return new S3Client({
    region: process.env.AWS_REGION ?? "eu-west-3",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

/**
 * The bucket is private: a key becomes either a CDN URL or a path on this
 * app's own `/api/files` proxy. One policy, in `@be-yours/core`.
 */
function buildPublicUrl(key: string): string {
  return buildMediaUrl(key, process.env.AWS_S3_PUBLIC_BASE_URL)
}

async function downloadAndUpload(
  s3: S3Client,
  url: string,
  filename: string,
): Promise<{ s3Key: string; publicUrl: string; size: number }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const s3Key = `cms/seed-${filename}-${crypto.randomUUID()}.jpg`;

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET_NAME!,
      Key: s3Key,
      Body: buffer,
      ContentType: "image/jpeg",
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );

  return { s3Key, publicUrl: buildPublicUrl(s3Key), size: buffer.length };
}

// ── Text field helper ────────────────────────────────────────────────

const t = (textValue: string) => ({ type: "text" as const, textValue });
const rt = (textValue: string) => ({ type: "richtext" as const, textValue });
const sel = (textValue: string) => ({ type: "select" as const, textValue });
const img = (mediaId: string, altText?: string) => ({
  type: "image" as const,
  mediaId,
  altText: altText ?? "",
});

// ── Image URLs ───────────────────────────────────────────────────────

const IMAGES = {
  heroBurger: {
    url: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800&q=80&auto=format&fit=crop",
    filename: "hero-burger",
  },
  ctaBackground: {
    url: "https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=1200&q=80&auto=format&fit=crop",
    filename: "cta-background",
  },
  aboutStory: {
    url: "https://images.unsplash.com/photo-1556910103-1c02745aae4d?w=1200&q=80&auto=format&fit=crop",
    filename: "about-story",
  },
};

// ── Main seed action ─────────────────────────────────────────────────

export const seedCmsContent = internalAction({
  args: {},
  handler: async (ctx) => {
    // 1. Get first store
    const store = await ctx.runQuery(internal.cmsSeedData.getFirstStore, {});
    if (!store) throw new Error("No store found. Create a store first.");
    const storeId = store._id as Id<"stores">;
    console.log(`[cmsSeed] Seeding CMS for store: ${store.name} (${storeId})`);

    // 2. Download images and upload to S3
    console.log("[cmsSeed] Downloading and uploading images to S3...");
    const s3 = createS3Client();

    const [heroBurger, ctaBg, aboutStory] = await Promise.all([
      downloadAndUpload(s3, IMAGES.heroBurger.url, IMAGES.heroBurger.filename),
      downloadAndUpload(s3, IMAGES.ctaBackground.url, IMAGES.ctaBackground.filename),
      downloadAndUpload(s3, IMAGES.aboutStory.url, IMAGES.aboutStory.filename),
    ]);
    console.log("[cmsSeed] Images uploaded to S3");

    // 3. Create cmsMedia records
    const [heroMediaId, ctaMediaId, storyMediaId] = await Promise.all([
      ctx.runMutation(internal.cmsSeedData.createMediaRecord, {
        storeId,
        filename: "hero-burger.jpg",
        mimeType: "image/jpeg",
        size: heroBurger.size,
        s3Key: heroBurger.s3Key,
        sourceUrl: heroBurger.publicUrl,
        width: 800,
        height: 600,
      }),
      ctx.runMutation(internal.cmsSeedData.createMediaRecord, {
        storeId,
        filename: "cta-background.jpg",
        mimeType: "image/jpeg",
        size: ctaBg.size,
        s3Key: ctaBg.s3Key,
        sourceUrl: ctaBg.publicUrl,
        width: 1200,
        height: 800,
      }),
      ctx.runMutation(internal.cmsSeedData.createMediaRecord, {
        storeId,
        filename: "about-story.jpg",
        mimeType: "image/jpeg",
        size: aboutStory.size,
        s3Key: aboutStory.s3Key,
        sourceUrl: aboutStory.publicUrl,
        width: 1200,
        height: 800,
      }),
    ]);
    console.log("[cmsSeed] Media records created");

    // 4. Seed all pages
    const pages = buildAllPages(
      heroMediaId as string,
      ctaMediaId as string,
      storyMediaId as string,
    );

    for (const { pageSlug, blocks } of pages) {
      console.log(`[cmsSeed] Seeding page: ${pageSlug}`);
      await ctx.runMutation(internal.cmsSeedData.seedAndPublishPage, {
        storeId,
        pageSlug,
        blocks,
      });
    }

    console.log(`[cmsSeed] Done! Seeded ${pages.length} CMS pages.`);
    return { seededPages: pages.length };
  },
});

// ── Page content definitions ─────────────────────────────────────────

function buildAllPages(heroMediaId: string, ctaMediaId: string, storyMediaId: string) {
  return [
    // ─── STOREFRONT ──────────────────────────────────────────────────
    {
      pageSlug: "homepage",
      blocks: {
        seo: {
          metaTitle: t("Restaurant — Commandez en ligne"),
          metaDescription: t("Découvrez notre menu et commandez vos plats préférés en ligne."),
          robots: sel("index, follow"),
        },
        // No badge and no floating stamps. « Restaurant Premium », « Top Rated ·
        // Gourmet Choice » and « Livraison rapide · 15-30 Mins » used to be seeded
        // here, which put a rating stamp and a delivery time on a site whose owner
        // had stated neither — see `no-fabricated-social-proof.test.ts`. The owner
        // fills those fields in the CMS if they have something true to say.
        hero: {
          title: t("Bienvenue Chez {Nous}"),
          subtitle: t("Découvrez nos plats préparés avec passion et des ingrédients frais, livrés directement chez vous ou à emporter."),
          image: img(heroMediaId, "Burger gourmet"),
          ctaLabel: t("Voir le Menu"),
        },
        features: {
          feature1Label: t("Livraison ou retrait"),
          feature2Label: t("Paiement sécurisé"),
          feature3Label: t("Une cuisine faite maison"),
          feature4Label: t("Click & Collect"),
          feature5Label: t("Commande en ligne"),
        },
        trendingMeals: {
          sectionTitle: t("Explorez nos restaurants & plats tendance"),
          viewAllLabel: t("Tout voir"),
        },
        categories: {
          badge: t("Découvrez le menu"),
          sectionTitle: t("Nos meilleures catégories"),
          description: t("Explorez notre large variété de catégories culinaires, des burgers juteux aux salades fraîches."),
        },
        vegetarianMeals: {
          badge: t("100% Healthy"),
          sectionTitle: t("Idéal pour les végétariens"),
          description: t("Des options végétales délicieuses qui ne font aucun compromis sur le goût."),
          viewAllLabel: t("Tout voir"),
        },
        cta: {
          title: t("Prêt à {commander} ?"),
          subtitle: t("Découvrez notre menu complet et commandez vos plats préférés en quelques clics."),
          buttonText: t("Explorer le Menu"),
          backgroundImage: img(ctaMediaId, "Plat gastronomique"),
        },
        testimonials: {
          badge: t("Témoignages"),
          sectionTitle: t("Ce que disent nos {clients}"),
        },
        blog: {
          sectionTitle: t("Consultez notre {Blog}"),
          viewAllLabel: t("Tout voir"),
        },
      },
    },
    {
      pageSlug: "about",
      blocks: {
        seo: {
          metaTitle: t("À propos — Notre histoire"),
          metaDescription: t("Découvrez notre histoire, nos valeurs et notre passion pour la cuisine."),
          robots: sel("index, follow"),
        },
        hero: {
          badge: t("Notre Histoire"),
          title: t("Une passion pour la {cuisine}"),
          subtitle: t("Depuis notre ouverture, nous nous engageons à offrir une expérience culinaire exceptionnelle avec des ingrédients frais et locaux."),
        },
        story: {
          badge: t("Qui sommes-nous ?"),
          title: t("De la passion à {l'assiette}"),
          description: rt("Notre aventure a commencé avec une idée simple : proposer une cuisine authentique, préparée avec des produits frais et de saison. Chaque plat raconte une histoire, celle de nos producteurs locaux, de notre équipe passionnée et de notre engagement envers la qualité.\n\nAujourd'hui, nous continuons de perpétuer cette tradition en alliant savoir-faire artisanal et innovation culinaire pour vous offrir le meilleur à chaque bouchée."),
          image: img(storyMediaId, "Notre cuisine"),
        },
        values: {
          badge: t("Nos Valeurs"),
          title: t("Ce qui nous {anime}"),
          value1Title: t("Ingrédients Frais"),
          value1Description: t("Nous sélectionnons chaque jour les meilleurs produits auprès de producteurs locaux pour garantir fraîcheur et qualité."),
          value2Title: t("Fait avec Amour"),
          value2Description: t("Chaque plat est préparé avec soin par notre équipe de chefs passionnés qui mettent tout leur cœur dans la cuisine."),
          value3Title: t("Saveurs Authentiques"),
          value3Description: t("Nos recettes respectent la tradition tout en apportant une touche de modernité pour surprendre vos papilles."),
        },
        // No stats: « 10K+ clients satisfaits », « 15 min temps moyen de
        // livraison », « 4.9/5 note moyenne » and « 3 restaurants » were seeded
        // here, four figures nobody measured. The page draws a stat only when the
        // owner has filled one in (`statItems.length > 0` in `AboutContent`).
        cta: {
          title: t("Prêt à {découvrir} nos saveurs ?"),
          subtitle: t("Parcourez notre menu et laissez-vous tenter par nos créations culinaires."),
          buttonText: t("Voir le Menu"),
        },
      },
    },
    {
      pageSlug: "blog",
      blocks: {
        seo: {
          metaTitle: t("Blog — Actualités et recettes"),
          metaDescription: t("Nos dernières actualités, recettes et conseils culinaires."),
          robots: sel("index, follow"),
        },
        hero: {
          badge: t("Notre Blog"),
          title: t("Saveurs, conseils & {inspirations}"),
          subtitle: t("Restez informé des dernières nouvelles, recettes et conseils de notre équipe culinaire."),
        },
        emptyState: {
          title: t("Aucun article pour le moment"),
          subtitle: t("Revenez bientôt pour découvrir nos articles sur la cuisine, les recettes et les tendances culinaires."),
        },
      },
    },
    {
      pageSlug: "contact",
      blocks: {
        seo: {
          metaTitle: t("Contact — Nous contacter"),
          metaDescription: t("Contactez-nous pour toute question, suggestion ou réservation."),
          robots: sel("index, follow"),
        },
        hero: {
          badge: t("Contactez-nous"),
          title: t("On est là pour {vous}"),
          subtitle: t("Une question, une suggestion ou un commentaire ? N'hésitez pas à nous contacter, notre équipe vous répondra dans les plus brefs délais."),
        },
        form: {
          heading: t("Envoyez-nous un message"),
          // No delay: « … sous 24h » was seeded here, so a fresh site published a
          // response time its owner never chose. See the contact page's
          // `responseTime` block for where an owner states one.
          description: t("Remplissez le formulaire ci-dessous pour nous écrire."),
          submitLabel: t("Envoyer le message"),
        },
        info: {
          addressTitle: t("Adresse"),
          hoursTitle: t("Horaires"),
          contactTitle: t("Contact"),
        },
      },
    },
    {
      pageSlug: "storefront-layout",
      blocks: {
        seo: {
          metaTitle: t("Restaurant"),
          metaDescription: t("Votre restaurant en ligne — commandez vos plats préférés."),
          robots: sel("index, follow"),
        },
        /* THE BLOCK THE HEADER ACTUALLY READS (#613). It was absent from this
           seed entirely — `grep -c branding` returned 0 — while `header`
           below was filled in, so an owner saw a brand name saved in the
           editor and their diners saw the vendor's. Both are written now, and
           `resolveBrandName` reads this one first. */
        branding: {
          brandName: t("Restaurant"),
        },
        header: {
          brandName: t("Restaurant"),
          menuLabel: t("Menu"),
          cartLabel: t("Panier"),
          accountLabel: t("Mon Compte"),
          signinLabel: t("Connexion"),
        },
        footer: {
          poweredBy: t("Propulsé par BeYours"),
          copyrightText: t("© 2026 Restaurant. Tous droits réservés."),
        },
      },
    },
    {
      pageSlug: "store-selector",
      blocks: {
        header: {
          title: t("Choisissez votre restaurant"),
          subtitle: t("Sélectionnez le restaurant le plus proche de chez vous pour commencer votre commande."),
        },
        emptyState: {
          title: t("Aucun restaurant disponible"),
          subtitle: t("Aucun restaurant n'est disponible pour le moment. Veuillez réessayer ultérieurement."),
        },
      },
    },

    // ─── CATALOG ─────────────────────────────────────────────────────
    {
      pageSlug: "menu",
      blocks: {
        seo: {
          metaTitle: t("Menu — Nos plats"),
          metaDescription: t("Découvrez notre menu complet avec une sélection de plats frais et savoureux."),
          robots: sel("index, follow"),
        },
        header: {
          title: t("Notre Menu"),
          subtitle: t("Découvrez notre sélection de plats préparés avec des ingrédients frais et de qualité."),
        },
        emptyState: {
          title: t("Menu en préparation"),
          subtitle: t("Notre menu sera bientôt disponible. Revenez vite !"),
        },
      },
    },
    {
      pageSlug: "category-menu",
      blocks: {
        seo: {
          metaTitle: t("Catégorie"),
          metaDescription: t("Découvrez les plats de cette catégorie."),
          robots: sel("index, follow"),
        },
        header: {
          title: t("Catégorie"),
        },
        emptyState: {
          title: t("Aucun plat dans cette catégorie"),
          subtitle: t("Cette catégorie est vide pour le moment. Découvrez nos autres catégories."),
        },
      },
    },
    {
      pageSlug: "product-detail",
      blocks: {
        seo: {
          metaTitle: t("Détail du produit"),
          metaDescription: t("Découvrez les détails de ce plat et ajoutez-le à votre panier."),
          robots: sel("index, follow"),
        },
        header: {
          title: t("Détail du produit"),
        },
        sections: {
          descriptionTitle: t("Description"),
          optionsTitle: t("Options & Suppléments"),
          similarTitle: t("Vous aimerez aussi"),
        },
        actions: {
          addToCartLabel: t("Ajouter au panier"),
          outOfStockLabel: t("Rupture de stock"),
        },
      },
    },

    // ─── ORDER ───────────────────────────────────────────────────────
    {
      pageSlug: "cart",
      blocks: {
        header: {
          title: t("Votre Panier"),
          subtitle: t("Vérifiez votre commande avant de passer au paiement."),
        },
        emptyState: {
          title: t("Votre panier est vide"),
          subtitle: t("Ajoutez des plats depuis notre menu pour commencer votre commande."),
          ctaLabel: t("Voir le menu"),
        },
        actions: {
          checkoutLabel: t("Passer commande"),
          continueShopping: t("Continuer mes achats"),
        },
      },
    },
    {
      pageSlug: "checkout",
      blocks: {
        header: {
          title: t("Finaliser la commande"),
          subtitle: t("Renseignez vos informations pour finaliser votre commande."),
        },
        sections: {
          orderSummaryTitle: t("Récapitulatif de commande"),
          paymentTitle: t("Mode de paiement"),
          deliveryTitle: t("Informations de livraison"),
        },
        actions: {
          submitLabel: t("Confirmer la commande"),
          backLabel: t("Retour au panier"),
        },
      },
    },
    {
      pageSlug: "order-tracking",
      blocks: {
        header: {
          title: t("Suivi de commande"),
          subtitle: t("Suivez l'avancement de votre commande en temps réel."),
        },
        statuses: {
          pendingLabel: t("En attente"),
          preparingLabel: t("En préparation"),
          readyLabel: t("Prête"),
          deliveredLabel: t("Livrée"),
        },
      },
    },

    // ─── AUTH ─────────────────────────────────────────────────────────
    {
      pageSlug: "sign-in",
      blocks: {
        hero: {
          title: t("Bon retour parmi nous"),
          subtitle: rt("Connectez-vous pour accéder à votre compte, suivre vos commandes et profiter de nos offres exclusives."),
        },
        form: {
          heading: t("Connexion"),
          submitLabel: t("Se connecter"),
          forgotLink: t("Mot de passe oublié ?"),
          signupLink: t("Pas encore de compte ? Inscrivez-vous"),
        },
      },
    },
    {
      pageSlug: "sign-up",
      blocks: {
        hero: {
          title: t("Créez votre compte"),
          subtitle: rt("Rejoignez-nous pour commander facilement, sauvegarder vos favoris et recevoir des offres personnalisées."),
        },
        form: {
          heading: t("Inscription"),
          submitLabel: t("Créer mon compte"),
          signinLink: t("Déjà un compte ? Connectez-vous"),
        },
      },
    },
    {
      pageSlug: "forgot-password",
      blocks: {
        form: {
          heading: t("Mot de passe oublié"),
          description: t("Entrez votre adresse email et nous vous enverrons un lien pour réinitialiser votre mot de passe."),
          submitLabel: t("Envoyer le lien"),
          signinLink: t("Retour à la connexion"),
        },
      },
    },

    // ─── ACCOUNT ─────────────────────────────────────────────────────
    {
      pageSlug: "account",
      blocks: {
        header: {
          title: t("Mon Compte"),
          subtitle: t("Gérez vos informations personnelles, commandes et adresses."),
        },
        navigation: {
          ordersLabel: t("Mes commandes"),
          addressesLabel: t("Mes adresses"),
          favoritesLabel: t("Mes favoris"),
          logoutLabel: t("Se déconnecter"),
        },
      },
    },
    {
      pageSlug: "account-orders",
      blocks: {
        header: {
          title: t("Historique des commandes"),
          subtitle: t("Retrouvez l'ensemble de vos commandes passées."),
        },
        emptyState: {
          title: t("Aucune commande"),
          subtitle: t("Vous n'avez pas encore passé de commande. Découvrez notre menu !"),
        },
      },
    },
    {
      pageSlug: "account-addresses",
      blocks: {
        header: {
          title: t("Mes adresses"),
          subtitle: t("Gérez vos adresses de livraison pour commander plus rapidement."),
        },
        emptyState: {
          title: t("Aucune adresse enregistrée"),
          subtitle: t("Ajoutez une adresse de livraison pour faciliter vos prochaines commandes."),
        },
      },
    },
    {
      pageSlug: "account-favorites",
      blocks: {
        header: {
          title: t("Mes favoris"),
          subtitle: t("Retrouvez vos plats préférés en un clic."),
        },
        emptyState: {
          title: t("Aucun favori"),
          subtitle: t("Ajoutez des plats à vos favoris pour les retrouver facilement."),
        },
      },
    },

    // ─── GAMES ───────────────────────────────────────────────────────
    {
      pageSlug: "game",
      blocks: {
        hero: {
          title: t("Tentez votre chance !"),
          subtitle: t("Jouez et gagnez des réductions exclusives sur vos prochaines commandes."),
        },
        instructions: {
          title: t("Comment jouer ?"),
          description: rt("1. Scannez le QR code sur votre table\n2. Complétez les actions demandées\n3. Lancez la roue et découvrez si vous avez gagné !\n\nBonne chance !"),
        },
        results: {
          winTitle: t("Félicitations ! 🎉"),
          winDescription: t("Vous avez gagné ! Remplissez le formulaire pour recevoir votre récompense par email."),
          loseTitle: t("Pas cette fois..."),
          loseDescription: t("Pas de chance cette fois-ci. Revenez demain pour retenter votre chance !"),
        },
      },
    },
  ];
}
