import type { PageDefinition } from "@be-yours/cms"

export const forgotPasswordPage: PageDefinition = {
  slug: "forgot-password",
  label: "Page mot de passe oublié",
  groupId: "auth",
  /** NOT read by anything (#630) — see `PageDefinition.rendered`. */
  rendered: false,

  blocks: [
    {
      key: "form",
      label: "Formulaire de réinitialisation",
      fields: {
        heading: {
          type: "text",
          label: "Titre",
          required: true,
          maxLength: 100,
          hasCodeFallback: true,
        },
        description: {
          type: "text",
          label: "Description",
          maxLength: 300,
          hasCodeFallback: true,
        },
        submitLabel: {
          type: "text",
          label: "Texte du bouton",
          required: true,
          maxLength: 50,
          hasCodeFallback: true,
        },
        signinLink: {
          type: "text",
          label: "Texte lien retour connexion",
          maxLength: 100,
          hasCodeFallback: true,
        },
      },
    },
  ],
}
