import type { PageDefinition } from "@be-yours/cms"

export const signInPage: PageDefinition = {
  slug: "sign-in",
  label: "Page de connexion",
  groupId: "auth",
  /** NOT read by anything (#630) — see `PageDefinition.rendered`. */
  rendered: false,

  blocks: [
    {
      key: "hero",
      label: "Section principale",
      fields: {
        title: {
          type: "text",
          label: "Titre",
          required: true,
          maxLength: 100,
          hasCodeFallback: true,
        },
        subtitle: {
          type: "richtext",
          label: "Sous-titre",
          maxLength: 500,
          hasCodeFallback: true,
        },
        image: {
          type: "image",
          label: "Image d'illustration",
          required: false,
          translatable: false,
          hasCodeFallback: true,
        },
      },
    },
    {
      key: "form",
      label: "Formulaire de connexion",
      fields: {
        heading: {
          type: "text",
          label: "Titre du formulaire",
          required: true,
          maxLength: 100,
          hasCodeFallback: true,
        },
        submitLabel: {
          type: "text",
          label: "Texte du bouton",
          required: true,
          maxLength: 50,
          hasCodeFallback: true,
        },
        forgotLink: {
          type: "text",
          label: "Texte lien mot de passe oublié",
          maxLength: 100,
          hasCodeFallback: true,
        },
        signupLink: {
          type: "text",
          label: "Texte lien inscription",
          maxLength: 100,
          hasCodeFallback: true,
        },
      },
    },
  ],
}
