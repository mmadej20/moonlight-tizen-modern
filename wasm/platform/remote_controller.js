function remoteControllerHandler(e) {
  isGamepadActive = false;
  const keyCode = e.keyCode;

  switch (keyCode) {
    case tvKey.KEY_UP:
      // Navigate in the up direction
      Navigation.up();
      break;
    case tvKey.KEY_DOWN:
      // Navigate in the down direction
      Navigation.down();
      break;
    case tvKey.KEY_LEFT:
      // Navigate in the left direction
      Navigation.left();
      break;
    case tvKey.KEY_RIGHT:
      // Navigate in the right direction
      Navigation.right();
      break;
    case tvKey.KEY_ENTER:
    case tvKey.KEY_REMOTE_ENTER:
      e.preventDefault(); // Prevent native asynchronous click
      // Select the current item
      Navigation.accept();
      break;
    case tvKey.KEY_RETURN:
      // Go back or cancel the operation
      Navigation.back();
      break;
    // The volume keys come here only while the application has taken them from the system (during a stream, with the bar of
    // Moonlight): then the application changes the volume and shows its bar. Otherwise the system handles them and shows its own
    case tvKey.KEY_VOLUME_UP:
      // Increase the volume
      VolumeControl.up();
      break;
    case tvKey.KEY_VOLUME_DOWN:
      // Decrease the volume
      VolumeControl.down();
      break;
    case tvKey.KEY_VOLUME_MUTE:
      // Mute or unmute
      VolumeControl.toggleMute();
      break;
    case tvKey.KEY_CHANNEL_UP:
      // Triggers the press action
      Navigation.press();
      break;
    case tvKey.KEY_CHANNEL_DOWN:
      // Triggers the switch action
      Navigation.switch();
      break;
    case tvKey.KEY_RED:
      // Terminate the connection
      if (isInGame === true) {
        Module.stopStream();
      }
      break;
    case tvKey.KEY_YELLOW:
      // Toggle performance stats overlay
      if (isInGame === true) {
        Module.toggleStats();
      }
      break;
    case tvKey.KEY_GREEN:
      // Open or close the stream menu
      if (isInGame === true) {
        StreamMenu.toggle();
      }
      break;
    default:
      break;
  }
}
