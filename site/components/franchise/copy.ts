/**
 * /franchise: the visitor copy. CLIENT ZONE. Owner: agent « réseau + franchise » (site/ART_DIRECTION.md § 14).
 *
 * Facts from BRIEF.md (sections 1, 3, 9). The brand's three lines are its own, tutoyées where they address
 * the reader: « Street food indien nouvelle génération », « Ouvre un restaurant sans extraction »,
 * « Kurry Up s'adapte aux villes, pas l'inverse ». NO AMOUNT of any kind (entry fee, royalties, investment):
 * the sources contradict each other, every money line is « À confirmer » (site/A_COMPLETER.md). The size of
 * the network is the brand's claim, shown with « selon la marque » and « À confirmer ».
 */
import { typoDeep } from '@/site/components/restaurants/typo'

export const FR = typoDeep({
  meta: {
    title: 'Ouvrir un Kurry Up | Franchise',
    description:
      'Street food indien nouvelle génération : l\'histoire de Kurry Up, de Mahatma en 1965 au réseau de franchise lancé en 2023, et le formulaire de candidature.',
  },
  confirmer: 'À confirmer',
  tete: {
    surtitre: 'Ouvrir un Kurry Up',
    titre: 'Street food indien nouvelle génération',
    lead: 'Ouvre un restaurant sans extraction. Kurry Up s\'adapte aux villes, pas l\'inverse.',
    candidater: 'Déposer ma candidature',
    savoir: 'Ce qui reste à confirmer',
  },
  histoire: {
    surtitre: 'Le concept',
    titre: 'D\'une table de famille à un réseau',
    dates: [
      {
        annee: '1965',
        titre: 'Mahatma',
        texte: 'Une famille ouvre Mahatma, un restaurant indo-pakistanais à Paris.',
      },
      {
        annee: '2015',
        titre: 'Kurry Up, rue Rennequin',
        texte: 'Ses enfants, passés par Londres, créent Kurry Up dans le 17e : la cuisine indienne, plus rapide et plus accessible.',
      },
      {
        annee: '2023',
        titre: 'La franchise, le nouveau décor',
        texte: 'En juin, la franchise est lancée. En octobre, l\'enseigne change d\'identité au restaurant de la rue de la Boétie : graffiti, tuk-tuks, four tandoor.',
      },
    ],
  },
  arguments: {
    surtitre: 'Le modèle',
    titre: 'Ce que dit la marque',
    extraction: {
      titre: 'Ouvre un restaurant sans extraction',
      texte: 'La marque présente un concept qui se passe de conduit d\'extraction : un critère qui compte quand on cherche un local.',
    },
    villes: {
      titre: 'Kurry Up s\'adapte aux villes, pas l\'inverse',
      texte: 'Des restaurants à Paris, Lyon, Neuilly-sur-Seine, Rennes, Massy et Saint-Denis de La Réunion, et Fort-de-France annoncé.',
      lien: 'Voir le mur des adresses',
    },
    promesse: {
      titre: 'La promesse au client',
      retrait: { nombre: '10', unite: 'min', texte: 'retrait sur place' },
      livraison: { nombre: '1', unite: 'h', texte: 'livraison max' },
    },
    reseau: {
      titre: 'Le réseau',
      restaurants: { nombre: '30', texte: 'restaurants en exploitation ou en développement' },
      franchises: { nombre: '24', texte: 'franchisés' },
      source: 'Selon la marque.',
    },
  },
  inconnu: {
    surtitre: 'Avant de candidater',
    titre: 'Ce qui reste à confirmer',
    lead: 'Les conditions d\'entrée et le parcours d\'ouverture seront précisés par la marque. Aucun chiffre n\'est affiché ici tant qu\'il n\'est pas confirmé.',
    points: [
      { terme: 'Droit d\'entrée', texte: 'Montant à confirmer par la marque.' },
      { terme: 'Redevances', texte: 'Taux et assiette à confirmer.' },
      { terme: 'Apport et investissement', texte: 'À confirmer par la marque.' },
      { terme: 'Local et emplacement', texte: 'Surface et type d\'emplacement à confirmer.' },
      { terme: 'Formation et accompagnement', texte: 'Durée et contenu à confirmer.' },
      { terme: 'Contrat', texte: 'Durée et zone à confirmer.' },
      { terme: 'Délai d\'ouverture', texte: 'À confirmer.' },
      {
        terme: 'Interlocuteur',
        texte: 'Le franchiseur est Kurry Up Développement (registre des entreprises). Le destinataire des candidatures reste à confirmer.',
      },
    ],
  },
  form: {
    surtitre: 'Candidature',
    titre: 'Parle-nous de ton projet',
    lead: 'Démonstration : le formulaire vérifie tes réponses et te confirme la candidature à l\'écran. Rien n\'est envoyé, rien n\'est enregistré.',
    champs: {
      nom: { label: 'Prénom et nom', aide: '' },
      email: { label: 'E-mail', aide: 'Pour te répondre.' },
      telephone: { label: 'Téléphone', aide: 'Un numéro français ou au format international (+33…).' },
      ville: { label: 'Ville visée', aide: 'Là où tu voudrais ouvrir.' },
      message: { label: 'Ton projet (facultatif)', aide: 'Ton parcours, ton calendrier, un local repéré : ce que tu veux.' },
      accord: { label: 'J\'accepte d\'être recontacté au sujet de ma candidature.' },
    },
    erreurs: {
      titre: 'Il manque quelque chose',
      nom: 'Écris ton prénom et ton nom.',
      emailVide: 'Écris ton adresse e-mail.',
      emailFaux: 'Cette adresse e-mail ne semble pas complète.',
      telVide: 'Écris ton numéro de téléphone.',
      telFaux: 'Ce numéro ne semble pas valide.',
      ville: 'Écris la ville où tu voudrais ouvrir.',
      message: 'Ton message dépasse 1 000 caractères.',
      accord: 'Coche la case pour qu\'on puisse te recontacter.',
    },
    envoyer: 'Valider ma candidature',
    merci: {
      titre: 'Merci',
      texte: 'Ta candidature pour {ville} est bien remplie. Démonstration : elle n\'a été envoyée nulle part.',
      suite: 'Sur le site en ligne, elle partira vers l\'équipe franchise de la marque.',
      recommencer: 'Remplir à nouveau',
    },
  },
})
