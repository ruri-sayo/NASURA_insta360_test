# Insta360 X4 360° Viewer / Mac Camera VR

Macのカメラ映像を、同じWi-Fiに接続したQuest 3SのブラウザへWebRTCで送るローカルWebアプリです。

## 起動

```bash
npm start
```

### X4をこのブラウザで直接見る

1. X4をUSB接続し、本体のUSBモードで **Webcam Mode** を選択します（充電／ファイル転送ではありません）。
2. Macで `http://localhost:5324/` を開き、「カメラを選ぶ」→X4→「接続する」を押します。
3. 映像上をドラッグ／スワイプして視点を移動し、ホイールまたはピンチでズームします。

カメラ許可後、実際のデバイス名・解像度・fps・アスペクト比を診断欄に表示します。X4のWebcam Modeが2880×1440 (2:1)を返す場合は360°ビューとして表示されます。

1. Macで `http://localhost:5324/broadcast` を開く
2. 「カメラを開始」を押して、ブラウザのカメラ許可を与える
3. Quest 3Sのブラウザで `http://163.221.154.235:5324/viewer` を開く
4. 「接続する」を押す

### Quest 3Sで360° WebXR表示

1. Macで `/broadcast` を開き、配信カメラにInsta360 X4を選んで開始します。
2. Quest Browserで `/viewer` を開いて「接続する」を押します。
3. 映像が届いたら「VRで見る」を押します。X4の2:1映像が球面の内側に表示され、頭の向きに追従します。

Quest Browserの `immersive-vr` は**信頼されたHTTPS**でのみ利用できます。通常の `http://192.168...` ではWebRTCの平面プレビューまでは動作しても、VR開始ボタンは有効になりません。HTTPS証明書がある場合は次のように起動できます。

```bash
HTTPS_KEY_PATH=/absolute/path/server-key.pem \
HTTPS_CERT_PATH=/absolute/path/server-cert.pem \
npm start
```

証明書はQuest側でも信頼され、URLのホスト名またはIPアドレスと一致している必要があります。Tailscale Serveなど、Questから信頼済みHTTPS URLでMacへ到達できるリバースプロキシを使う方法でも構いません。

## QuestコントローラーでMacを操作

映像接続後、Quest画面右側の操作パッドをTouchコントローラーのレーザーで指してください。レーザー位置がMacの映像上にカーソルとして表示され、トリガーの押下状態も送信されます。A/X・B/Y相当の画面ボタン、方向キー、タッチ操作にも対応しています。

Questブラウザが通常のGamepad APIとしてコントローラーを公開している場合は、スティックと物理ボタンも自動で読み取ります。WebXR専用の生コントローラー情報はHTTPS接続が必要です。

MacのIPが変わった場合は、次のコマンドで `en0` のIPを確認してください。

```bash
ipconfig getifaddr en0
```

## 注意

- MacとQuestを同じWi-Fiに接続してください。
- macOSのファイアウォール確認が表示された場合は、Node.jsの受信接続を許可してください。
- WebXR表示は単眼360°映像を両眼へ投影するため、頭の向きには追従しますが奥行きの視差はありません。
- X4がブラウザに通常のUVCカメラとして公開される必要があります。ブラウザやX4のファームウェアによっては、Webcam ModeがOBS等の特定アプリのみで動作する場合があります。
- 2:1以外の映像は診断欄で警告します。自動スティッチングや魚眼RAW入力には対応していません。
- カメラAPIはHTTPSまたはlocalhostでのみ利用できます。
