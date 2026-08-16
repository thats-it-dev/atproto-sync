import { Plugin } from 'obsidian';

export default class NoteskyPlugin extends Plugin {
  async onload() {
    console.log('Notesky Sync loaded');
  }
}
