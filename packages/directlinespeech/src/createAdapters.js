/* eslint complexity: ["error", 33] */

import { AudioConfig } from 'microsoft-cognitiveservices-speech-sdk/distrib/lib/src/sdk/Audio/AudioConfig';
import { BotFrameworkConfig, DialogServiceConnector, PropertyId } from 'microsoft-cognitiveservices-speech-sdk';
import { MicAudioSource } from 'microsoft-cognitiveservices-speech-sdk/distrib/lib/src/common.browser/MicAudioSource';

import createWebSpeechPonyfillFactory from './createWebSpeechPonyfillFactory';
import DirectLineSpeech from './DirectLineSpeech';
import patchDialogServiceConnectorInline from './patchDialogServiceConnectorInline';
import refreshDirectLineToken from './utils/refreshDirectLineToken';
import resolveFunctionOrReturnValue from './resolveFunctionOrReturnValue';

const DIRECT_LINE_TOKEN_RENEWAL_INTERVAL = 900000; // 15 minutes
const TOKEN_RENEWAL_INTERVAL = 120000;

export default async function create({
  audioConfig,
  audioContext,
  audioInputDeviceId,
  enableInternalHTTPSupport,
  enableTelemetry,
  fetchCredentials,
  speechRecognitionEndpointId,
  speechRecognitionLanguage = (typeof window !== 'undefined' &&
    typeof window.navigator !== 'undefined' &&
    window.navigator.language) ||
    'en-US',
  speechSynthesisDeploymentId,
  speechSynthesisOutputFormat,
  textNormalization,
  userID,
  username
}) {
  if (!fetchCredentials) {
    throw new Error('"fetchCredentials" must be specified.');
  }

  const { authorizationToken, directLineToken, region, subscriptionKey } = await resolveFunctionOrReturnValue(
    fetchCredentials
  );

  if (
    (!authorizationToken && !subscriptionKey) ||
    (authorizationToken && subscriptionKey) ||
    (authorizationToken && typeof authorizationToken !== 'string') ||
    (subscriptionKey && typeof subscriptionKey !== 'string') ||
    (enableInternalHTTPSupport && !directLineToken)
  ) {
    throw new Error(
      '"fetchCredentials" must return either "authorizationToken" or "subscriptionKey" as a non-empty string only. If enableInternalHTTPSupport is set to true, then it should also return a non-empty "directLineToken"'
    );
  }

  if (typeof enableTelemetry !== 'undefined') {
    console.warn(
      'botframework-directlinespeech: Telemetry options are not yet supported. Please refer to Cognitive Services documentation for details.'
    );
  }

  if (!region || typeof region !== 'string') {
    throw new Error('"fetchCredentials" must return "region" as a non-empty string.');
  }

  if (audioConfig && audioInputDeviceId) {
    console.warn(
      'botframework-directlinespeech-sdk: Only "audioConfig" or "audioInputDeviceId" can be specified, but not both; ignoring "audioInputDeviceId".'
    );
  } else if (!audioConfig) {
    if (audioInputDeviceId) {
      audioConfig = AudioConfig.fromMicrophoneInput(audioInputDeviceId);
    } else {
      audioConfig = AudioConfig.fromDefaultMicrophoneInput();
    }

    // WORKAROUND: In Speech SDK 1.12.0-1.13.1, it dropped support of macOS/iOS Safari.
    //             This code is adopted from microsoft-cognitiveservices-speech-sdk/src/common.browser/MicAudioSource.ts.
    //             We will not need this code when using Speech SDK 1.14.0 or up.
    // TODO: [P1] #3575 Remove the following lines when bumping to Speech SDK 1.14.0 or higher
    const { privSource: source } = audioConfig;

    source.createAudioContext = () => {
      if (!!source.privContext) {
        return;
      }

      const AudioContext = window.AudioContext || window.webkitAudioContext;

      if (typeof AudioContext === 'undefined') {
        throw new Error('Browser does not support Web Audio API (AudioContext/webkitAudioContext is not available).');
      }

      if (navigator.mediaDevices.getSupportedConstraints().sampleRate) {
        source.privContext = new AudioContext({ sampleRate: MicAudioSource.AUDIOFORMAT.samplesPerSec });
      } else {
        source.privContext = new AudioContext();
      }
    };
  }

  if (speechRecognitionEndpointId) {
    console.warn(
      'botframework-directlinespeech: Custom Speech is currently not supported; ignoring "speechRecognitionEndpointId".'
    );
  }

  if (speechSynthesisDeploymentId) {
    console.warn(
      'botframework-directlinespeech: Custom Voice is currently not supported; ignoring "speechSynthesisDeploymentId".'
    );
  }

  if (speechSynthesisOutputFormat) {
    console.warn(
      'botframework-directlinespeech: Synthesis output format is currently not supported; ignoring "speechSynthesisOutputFormat".'
    );
  }

  if (textNormalization) {
    console.warn(
      'botframework-directlinespeech: Text normalization is currently not supported; ignoring "textNormalization".'
    );
  }

  if (userID || username) {
    console.warn(
      'botframework-directlinespeech: Custom "userId" and "username" are currently not supported and are ignored.'
    );
  }

  let config;

  if (authorizationToken) {
    config = BotFrameworkConfig.fromAuthorizationToken(authorizationToken, region);
  } else {
    config = BotFrameworkConfig.fromSubscription(subscriptionKey, region);
  }

  // If internal HTTP support is enabled, switch the endpoint to Direct Line on Direct Line Speech service.
  if (enableInternalHTTPSupport) {
    config.setProperty(
      PropertyId.SpeechServiceConnection_Endpoint,
      `wss://${encodeURI(region)}.convai.speech.microsoft.com/directline/api/v1`
    );

    config.setProperty(PropertyId.Conversation_ApplicationId, directLineToken);
  }

  // Supported options can be found in DialogConnectorFactory.js.

  // Set the language used for recognition.
  config.setProperty(PropertyId.SpeechServiceConnection_RecoLanguage, speechRecognitionLanguage);

  // The following code sets the output format.
  // As advised by the Speech team, this API may be subject to future changes.
  // We are not enabling output format option because it does not send detailed output format to the bot, rendering this option useless.
  // config.setProperty(PropertyId.SpeechServiceResponse_OutputFormatOption, OutputFormat[OutputFormat.Detailed]);

  // Set the user ID for starting the conversation.
  userID && config.setProperty(PropertyId.Conversation_From_Id, userID);

  // Set Custom Speech and Custom Voice.
  // The following code is copied from C#, and it is not working yet.
  // https://github.com/Azure-Samples/Cognitive-Services-Direct-Line-Speech-Client/blob/master/DLSpeechClient/MainWindow.xaml.cs
  // speechRecognitionEndpointId && config.setServiceProperty('cid', speechRecognitionEndpointId, ServicePropertyChannel.UriQueryParameter);
  // speechSynthesisDeploymentId && config.setProperty(PropertyId.conversation_Custom_Voice_Deployment_Ids, speechSynthesisDeploymentId);

  const dialogServiceConnector = patchDialogServiceConnectorInline(new DialogServiceConnector(config, audioConfig));

  dialogServiceConnector.connect();

  // Renew token per interval.
  if (authorizationToken) {
    const interval = setInterval(async () => {
      // #2660 If the connector has been disposed, we should stop renewing the token.

      // TODO: We should use a public implementation if Speech SDK has one related to "privIsDisposed".
      if (dialogServiceConnector.privIsDisposed) {
        clearInterval(interval);
      }

      const { authorizationToken, region: nextRegion } = await resolveFunctionOrReturnValue(fetchCredentials);

      if (!authorizationToken) {
        return console.warn(
          'botframework-directlinespeech-sdk: Renew token failed because "fetchCredentials" call returned no authorization token.'
        );
      }

      if (region !== nextRegion) {
        return console.warn(
          'botframework-directlinespeech-sdk: Region change is not supported for renewed token. Authorization token is not renewed.'
        );
      }

      dialogServiceConnector.authorizationToken = authorizationToken; // eslint-disable-line require-atomic-updates
    }, TOKEN_RENEWAL_INTERVAL);
  }

  // Renew token per interval.
  if (enableInternalHTTPSupport) {
    const interval = setInterval(async () => {
      // #2660 If the connector has been disposed, we should stop renewing the token.

      // TODO: We should use a public implementation if Speech SDK has one related to "privIsDisposed".
      if (dialogServiceConnector.privIsDisposed) {
        clearInterval(interval);
      }

      const refreshedDirectLineToken = await refreshDirectLineToken(directLineToken);

      if (!refreshedDirectLineToken) {
        return console.warn(
          'botframework-directlinespeech-sdk: Renew token failed because call to refresh token Direct Line API did not return a new token.'
        );
      }

      config.setProperty(PropertyId.Conversation_ApplicationId, refreshedDirectLineToken);

      dialogServiceConnector.properties.setProperty(PropertyId.Conversation_ApplicationId, refreshedDirectLineToken);
      dialogServiceConnector.connect();
    }, DIRECT_LINE_TOKEN_RENEWAL_INTERVAL);
  }

  const directLine = new DirectLineSpeech({ dialogServiceConnector });

  const webSpeechPonyfillFactory = createWebSpeechPonyfillFactory({
    audioContext,
    enableTelemetry,
    recognizer: dialogServiceConnector,
    textNormalization
  });

  return {
    directLine,
    webSpeechPonyfillFactory
  };
}
