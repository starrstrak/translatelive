# TranslateLive

Traduction en direct, dans le navigateur:

| Mode | Source | Sortie |
|------|--------|--------|
| 🖥 Vidéo / conférence | audio d'un onglet (YouTube, Zoom/Teams/Meet web, webinaires…) | texte, voix, ou les deux |
| 🎙 Mon micro | ce que vous dites | texte, voix, ou les deux |
| ⌨ Texte | ce que vous écrivez | texte, voix, ou les deux |

Langue source (ou détection auto) et langue cible au choix.

## Lancer

```bash
cp .env.example .env   # y mettre OPENAI_API_KEY
npm start              # http://localhost:3000
npm test
```

Aucune dépendance npm (Node ≥ 18). La clé reste côté serveur.

## Utiliser

- **Vidéo / conférence**: ouvrir la vidéo dans un onglet → *Démarrer* → choisir l'onglet et cocher
  **« Partager l'audio de l'onglet »**. Chrome/Edge ordinateur uniquement (Firefox/Safari ne partagent pas l'audio d'onglet).
- Sortie **voix**: baissez le volume de la vidéo d'origine, ou utilisez un casque (micro) pour éviter l'écho.
- Voix **Navigateur** = gratuit, qualité variable. Voix **OpenAI** = plus naturelle, coûte des appels API.

## Fonctionnement

Navigateur: capture → coupe sur silence (2,5–9 s) → WAV 16 kHz → `POST /api/audio` →
serveur: transcription (`gpt-4o-mini-transcribe`) → traduction (`gpt-4o-mini`, avec contexte précédent) →
texte affiché dans l'ordre; voix via `speechSynthesis` ou `/api/tts`.
Latence typique: durée de la phrase + 1–3 s. Si la voix prend du retard, les plus anciennes phrases sont sautées (reste « live »).

Modèles changeables via `.env` (`STT_MODEL`, `TRANSLATE_MODEL`, `TTS_MODEL`).

## Limites

- Pas une traduction mot à mot simultanée: elle suit les phrases (quelques secondes de décalage).
- Plateformes avec DRM ou apps natives (Zoom desktop): partager l'audio système n'est possible que sur Windows/ChromeOS via « Écran entier ».
- Serveur sans authentification: ne pas exposer publiquement tel quel (la clé API serait utilisable par tous).
