import { ref, computed } from 'vue'
import { apiFetch } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import type { CustomEmoji } from '@/types/mastodon'

// ── Compact built-in Unicode emoji list ──────────────────────────────
interface UnicodeEmoji {
  emoji: string
  name: string
  category: string
}

const UNICODE_EMOJIS: UnicodeEmoji[] = [
  // Smileys & People
  { emoji: '\u{1F600}', name: 'grinning', category: 'People' },
  { emoji: '\u{1F603}', name: 'smiley', category: 'People' },
  { emoji: '\u{1F604}', name: 'smile', category: 'People' },
  { emoji: '\u{1F601}', name: 'grin', category: 'People' },
  { emoji: '\u{1F606}', name: 'laughing', category: 'People' },
  { emoji: '\u{1F605}', name: 'sweat_smile', category: 'People' },
  { emoji: '\u{1F923}', name: 'rofl', category: 'People' },
  { emoji: '\u{1F602}', name: 'joy', category: 'People' },
  { emoji: '\u{1F642}', name: 'slightly_smiling', category: 'People' },
  { emoji: '\u{1F643}', name: 'upside_down', category: 'People' },
  { emoji: '\u{1F609}', name: 'wink', category: 'People' },
  { emoji: '\u{1F60A}', name: 'blush', category: 'People' },
  { emoji: '\u{1F607}', name: 'innocent', category: 'People' },
  { emoji: '\u{1F970}', name: 'smiling_hearts', category: 'People' },
  { emoji: '\u{1F60D}', name: 'heart_eyes', category: 'People' },
  { emoji: '\u{1F929}', name: 'star_struck', category: 'People' },
  { emoji: '\u{1F618}', name: 'kissing_heart', category: 'People' },
  { emoji: '\u{1F617}', name: 'kissing', category: 'People' },
  { emoji: '\u{1F61A}', name: 'kissing_closed_eyes', category: 'People' },
  { emoji: '\u{1F619}', name: 'kissing_smiling_eyes', category: 'People' },
  { emoji: '\u{1F60B}', name: 'yum', category: 'People' },
  { emoji: '\u{1F61B}', name: 'stuck_out_tongue', category: 'People' },
  { emoji: '\u{1F61C}', name: 'stuck_out_tongue_winking', category: 'People' },
  { emoji: '\u{1F92A}', name: 'zany', category: 'People' },
  { emoji: '\u{1F61D}', name: 'stuck_out_tongue_closed_eyes', category: 'People' },
  { emoji: '\u{1F911}', name: 'money_mouth', category: 'People' },
  { emoji: '\u{1F917}', name: 'hugging', category: 'People' },
  { emoji: '\u{1F92D}', name: 'hand_over_mouth', category: 'People' },
  { emoji: '\u{1F92B}', name: 'shushing', category: 'People' },
  { emoji: '\u{1F914}', name: 'thinking', category: 'People' },
  { emoji: '\u{1F910}', name: 'zipper_mouth', category: 'People' },
  { emoji: '\u{1F928}', name: 'raised_eyebrow', category: 'People' },
  { emoji: '\u{1F610}', name: 'neutral', category: 'People' },
  { emoji: '\u{1F611}', name: 'expressionless', category: 'People' },
  { emoji: '\u{1F636}', name: 'no_mouth', category: 'People' },
  { emoji: '\u{1F60F}', name: 'smirk', category: 'People' },
  { emoji: '\u{1F612}', name: 'unamused', category: 'People' },
  { emoji: '\u{1F644}', name: 'rolling_eyes', category: 'People' },
  { emoji: '\u{1F62C}', name: 'grimacing', category: 'People' },
  { emoji: '\u{1F925}', name: 'lying', category: 'People' },
  { emoji: '\u{1F60C}', name: 'relieved', category: 'People' },
  { emoji: '\u{1F614}', name: 'pensive', category: 'People' },
  { emoji: '\u{1F62A}', name: 'sleepy', category: 'People' },
  { emoji: '\u{1F924}', name: 'drooling', category: 'People' },
  { emoji: '\u{1F634}', name: 'sleeping', category: 'People' },
  { emoji: '\u{1F637}', name: 'mask', category: 'People' },
  { emoji: '\u{1F912}', name: 'thermometer_face', category: 'People' },
  { emoji: '\u{1F915}', name: 'bandage_face', category: 'People' },
  { emoji: '\u{1F922}', name: 'nauseated', category: 'People' },
  { emoji: '\u{1F92E}', name: 'vomiting', category: 'People' },
  { emoji: '\u{1F927}', name: 'sneezing', category: 'People' },
  { emoji: '\u{1F975}', name: 'hot', category: 'People' },
  { emoji: '\u{1F976}', name: 'cold', category: 'People' },
  { emoji: '\u{1F974}', name: 'woozy', category: 'People' },
  { emoji: '\u{1F635}', name: 'dizzy', category: 'People' },
  { emoji: '\u{1F631}', name: 'scream', category: 'People' },
  { emoji: '\u{1F616}', name: 'confounded', category: 'People' },
  { emoji: '\u{1F623}', name: 'persevere', category: 'People' },
  { emoji: '\u{1F61E}', name: 'disappointed', category: 'People' },
  { emoji: '\u{1F613}', name: 'sweat', category: 'People' },
  { emoji: '\u{1F629}', name: 'weary', category: 'People' },
  { emoji: '\u{1F62D}', name: 'sob', category: 'People' },
  { emoji: '\u{1F624}', name: 'triumph', category: 'People' },
  { emoji: '\u{1F620}', name: 'angry', category: 'People' },
  { emoji: '\u{1F621}', name: 'rage', category: 'People' },
  { emoji: '\u{1F92C}', name: 'cursing', category: 'People' },
  { emoji: '\u{1F608}', name: 'smiling_imp', category: 'People' },
  { emoji: '\u{1F47F}', name: 'imp', category: 'People' },
  { emoji: '\u{1F480}', name: 'skull', category: 'People' },
  { emoji: '\u{1F4A9}', name: 'poop', category: 'People' },
  { emoji: '\u{1F921}', name: 'clown', category: 'People' },
  { emoji: '\u{1F47B}', name: 'ghost', category: 'People' },
  { emoji: '\u{1F47D}', name: 'alien', category: 'People' },
  { emoji: '\u{1F916}', name: 'robot', category: 'People' },
  { emoji: '\u{1F44D}', name: 'thumbsup', category: 'People' },
  { emoji: '\u{1F44E}', name: 'thumbsdown', category: 'People' },
  { emoji: '\u{1F44B}', name: 'wave', category: 'People' },
  { emoji: '\u{1F44F}', name: 'clap', category: 'People' },
  { emoji: '\u{1F64F}', name: 'pray', category: 'People' },
  { emoji: '\u{1F4AA}', name: 'muscle', category: 'People' },
  { emoji: '\u{270C}\u{FE0F}', name: 'victory', category: 'People' },
  { emoji: '\u{1F91E}', name: 'crossed_fingers', category: 'People' },
  { emoji: '\u{1F918}', name: 'metal', category: 'People' },
  { emoji: '\u{1F44C}', name: 'ok_hand', category: 'People' },
  { emoji: '\u{1F448}', name: 'point_left', category: 'People' },
  { emoji: '\u{1F449}', name: 'point_right', category: 'People' },
  { emoji: '\u{1F446}', name: 'point_up', category: 'People' },
  { emoji: '\u{1F447}', name: 'point_down', category: 'People' },
  { emoji: '\u{270B}', name: 'raised_hand', category: 'People' },
  { emoji: '\u{1F91A}', name: 'raised_back_of_hand', category: 'People' },
  { emoji: '\u{1F590}\u{FE0F}', name: 'hand_splayed', category: 'People' },
  { emoji: '\u{1F919}', name: 'call_me', category: 'People' },

  // Nature & Animals
  { emoji: '\u{1F436}', name: 'dog', category: 'Nature' },
  { emoji: '\u{1F431}', name: 'cat', category: 'Nature' },
  { emoji: '\u{1F42D}', name: 'mouse', category: 'Nature' },
  { emoji: '\u{1F439}', name: 'hamster', category: 'Nature' },
  { emoji: '\u{1F430}', name: 'rabbit', category: 'Nature' },
  { emoji: '\u{1F98A}', name: 'fox', category: 'Nature' },
  { emoji: '\u{1F43B}', name: 'bear', category: 'Nature' },
  { emoji: '\u{1F43C}', name: 'panda', category: 'Nature' },
  { emoji: '\u{1F428}', name: 'koala', category: 'Nature' },
  { emoji: '\u{1F42F}', name: 'tiger', category: 'Nature' },
  { emoji: '\u{1F981}', name: 'lion', category: 'Nature' },
  { emoji: '\u{1F42E}', name: 'cow', category: 'Nature' },
  { emoji: '\u{1F437}', name: 'pig', category: 'Nature' },
  { emoji: '\u{1F438}', name: 'frog', category: 'Nature' },
  { emoji: '\u{1F435}', name: 'monkey', category: 'Nature' },
  { emoji: '\u{1F414}', name: 'chicken', category: 'Nature' },
  { emoji: '\u{1F427}', name: 'penguin', category: 'Nature' },
  { emoji: '\u{1F426}', name: 'bird', category: 'Nature' },
  { emoji: '\u{1F985}', name: 'eagle', category: 'Nature' },
  { emoji: '\u{1F989}', name: 'owl', category: 'Nature' },
  { emoji: '\u{1F987}', name: 'bat', category: 'Nature' },
  { emoji: '\u{1F43A}', name: 'wolf', category: 'Nature' },
  { emoji: '\u{1F417}', name: 'boar', category: 'Nature' },
  { emoji: '\u{1F434}', name: 'horse', category: 'Nature' },
  { emoji: '\u{1F984}', name: 'unicorn', category: 'Nature' },
  { emoji: '\u{1F41D}', name: 'bee', category: 'Nature' },
  { emoji: '\u{1F41B}', name: 'bug', category: 'Nature' },
  { emoji: '\u{1F98B}', name: 'butterfly', category: 'Nature' },
  { emoji: '\u{1F40C}', name: 'snail', category: 'Nature' },
  { emoji: '\u{1F41A}', name: 'shell', category: 'Nature' },
  { emoji: '\u{1F41E}', name: 'ladybug', category: 'Nature' },
  { emoji: '\u{1F420}', name: 'tropical_fish', category: 'Nature' },
  { emoji: '\u{1F419}', name: 'octopus', category: 'Nature' },
  { emoji: '\u{1F422}', name: 'turtle', category: 'Nature' },
  { emoji: '\u{1F40D}', name: 'snake', category: 'Nature' },
  { emoji: '\u{1F432}', name: 'dragon_face', category: 'Nature' },
  { emoji: '\u{1F335}', name: 'cactus', category: 'Nature' },
  { emoji: '\u{1F332}', name: 'evergreen', category: 'Nature' },
  { emoji: '\u{1F333}', name: 'deciduous_tree', category: 'Nature' },
  { emoji: '\u{1F334}', name: 'palm', category: 'Nature' },
  { emoji: '\u{1F331}', name: 'seedling', category: 'Nature' },
  { emoji: '\u{1F33F}', name: 'herb', category: 'Nature' },
  { emoji: '\u{1F340}', name: 'four_leaf_clover', category: 'Nature' },
  { emoji: '\u{1F341}', name: 'maple_leaf', category: 'Nature' },
  { emoji: '\u{1F342}', name: 'fallen_leaf', category: 'Nature' },
  { emoji: '\u{1F343}', name: 'leaf_in_wind', category: 'Nature' },
  { emoji: '\u{1F339}', name: 'rose', category: 'Nature' },
  { emoji: '\u{1F33B}', name: 'sunflower', category: 'Nature' },
  { emoji: '\u{1F337}', name: 'tulip', category: 'Nature' },
  { emoji: '\u{1F338}', name: 'cherry_blossom', category: 'Nature' },
  { emoji: '\u{1F33A}', name: 'hibiscus', category: 'Nature' },

  // Food & Drink
  { emoji: '\u{1F34E}', name: 'apple', category: 'Food' },
  { emoji: '\u{1F34A}', name: 'tangerine', category: 'Food' },
  { emoji: '\u{1F34B}', name: 'lemon', category: 'Food' },
  { emoji: '\u{1F34C}', name: 'banana', category: 'Food' },
  { emoji: '\u{1F349}', name: 'watermelon', category: 'Food' },
  { emoji: '\u{1F347}', name: 'grapes', category: 'Food' },
  { emoji: '\u{1F353}', name: 'strawberry', category: 'Food' },
  { emoji: '\u{1F351}', name: 'peach', category: 'Food' },
  { emoji: '\u{1F352}', name: 'cherries', category: 'Food' },
  { emoji: '\u{1F34D}', name: 'pineapple', category: 'Food' },
  { emoji: '\u{1F96D}', name: 'mango', category: 'Food' },
  { emoji: '\u{1F95D}', name: 'kiwi', category: 'Food' },
  { emoji: '\u{1F345}', name: 'tomato', category: 'Food' },
  { emoji: '\u{1F955}', name: 'carrot', category: 'Food' },
  { emoji: '\u{1F33D}', name: 'corn', category: 'Food' },
  { emoji: '\u{1F336}\u{FE0F}', name: 'hot_pepper', category: 'Food' },
  { emoji: '\u{1F954}', name: 'potato', category: 'Food' },
  { emoji: '\u{1F35E}', name: 'bread', category: 'Food' },
  { emoji: '\u{1F950}', name: 'croissant', category: 'Food' },
  { emoji: '\u{1F956}', name: 'baguette', category: 'Food' },
  { emoji: '\u{1F968}', name: 'pretzel', category: 'Food' },
  { emoji: '\u{1F9C0}', name: 'cheese', category: 'Food' },
  { emoji: '\u{1F356}', name: 'meat', category: 'Food' },
  { emoji: '\u{1F357}', name: 'poultry_leg', category: 'Food' },
  { emoji: '\u{1F354}', name: 'hamburger', category: 'Food' },
  { emoji: '\u{1F35F}', name: 'fries', category: 'Food' },
  { emoji: '\u{1F355}', name: 'pizza', category: 'Food' },
  { emoji: '\u{1F32E}', name: 'taco', category: 'Food' },
  { emoji: '\u{1F32F}', name: 'burrito', category: 'Food' },
  { emoji: '\u{1F37F}', name: 'popcorn', category: 'Food' },
  { emoji: '\u{1F363}', name: 'sushi', category: 'Food' },
  { emoji: '\u{1F35C}', name: 'ramen', category: 'Food' },
  { emoji: '\u{1F372}', name: 'stew', category: 'Food' },
  { emoji: '\u{1F35B}', name: 'curry', category: 'Food' },
  { emoji: '\u{1F371}', name: 'bento', category: 'Food' },
  { emoji: '\u{1F359}', name: 'rice_ball', category: 'Food' },
  { emoji: '\u{1F35A}', name: 'rice', category: 'Food' },
  { emoji: '\u{1F358}', name: 'rice_cracker', category: 'Food' },
  { emoji: '\u{1F365}', name: 'fish_cake', category: 'Food' },
  { emoji: '\u{1F361}', name: 'dango', category: 'Food' },
  { emoji: '\u{1F366}', name: 'ice_cream', category: 'Food' },
  { emoji: '\u{1F370}', name: 'cake', category: 'Food' },
  { emoji: '\u{1F382}', name: 'birthday_cake', category: 'Food' },
  { emoji: '\u{1F36B}', name: 'chocolate', category: 'Food' },
  { emoji: '\u{1F36C}', name: 'candy', category: 'Food' },
  { emoji: '\u{1F36D}', name: 'lollipop', category: 'Food' },
  { emoji: '\u{1F36E}', name: 'custard', category: 'Food' },
  { emoji: '\u{1F36F}', name: 'honey', category: 'Food' },
  { emoji: '\u{2615}', name: 'coffee', category: 'Food' },
  { emoji: '\u{1F375}', name: 'tea', category: 'Food' },
  { emoji: '\u{1F376}', name: 'sake', category: 'Food' },
  { emoji: '\u{1F37A}', name: 'beer', category: 'Food' },
  { emoji: '\u{1F37B}', name: 'beers', category: 'Food' },
  { emoji: '\u{1F377}', name: 'wine', category: 'Food' },
  { emoji: '\u{1F378}', name: 'cocktail', category: 'Food' },
  { emoji: '\u{1F379}', name: 'tropical_drink', category: 'Food' },
  { emoji: '\u{1F943}', name: 'whiskey', category: 'Food' },

  // Activities & Objects
  { emoji: '\u{26BD}', name: 'soccer', category: 'Activities' },
  { emoji: '\u{1F3C0}', name: 'basketball', category: 'Activities' },
  { emoji: '\u{1F3C8}', name: 'football', category: 'Activities' },
  { emoji: '\u{26BE}', name: 'baseball', category: 'Activities' },
  { emoji: '\u{1F3BE}', name: 'tennis', category: 'Activities' },
  { emoji: '\u{1F3D0}', name: 'volleyball', category: 'Activities' },
  { emoji: '\u{1F3B1}', name: 'billiards', category: 'Activities' },
  { emoji: '\u{1F3B3}', name: 'bowling', category: 'Activities' },
  { emoji: '\u{1F3AE}', name: 'video_game', category: 'Activities' },
  { emoji: '\u{1F3AF}', name: 'dart', category: 'Activities' },
  { emoji: '\u{1F3B2}', name: 'dice', category: 'Activities' },
  { emoji: '\u{1F3B0}', name: 'slot_machine', category: 'Activities' },
  { emoji: '\u{1F3A8}', name: 'art', category: 'Activities' },
  { emoji: '\u{1F3B5}', name: 'music', category: 'Activities' },
  { emoji: '\u{1F3B6}', name: 'notes', category: 'Activities' },
  { emoji: '\u{1F3A4}', name: 'microphone', category: 'Activities' },
  { emoji: '\u{1F3A7}', name: 'headphones', category: 'Activities' },
  { emoji: '\u{1F3AC}', name: 'movie', category: 'Activities' },
  { emoji: '\u{1F4F7}', name: 'camera', category: 'Activities' },
  { emoji: '\u{1F4F1}', name: 'phone', category: 'Activities' },
  { emoji: '\u{1F4BB}', name: 'laptop', category: 'Activities' },
  { emoji: '\u{1F4DA}', name: 'books', category: 'Activities' },
  { emoji: '\u{1F4DD}', name: 'memo', category: 'Activities' },
  { emoji: '\u{2709}\u{FE0F}', name: 'envelope', category: 'Activities' },
  { emoji: '\u{1F4E6}', name: 'package', category: 'Activities' },
  { emoji: '\u{1F511}', name: 'key', category: 'Activities' },
  { emoji: '\u{1F50D}', name: 'magnifying_glass', category: 'Activities' },
  { emoji: '\u{1F4A1}', name: 'bulb', category: 'Activities' },
  { emoji: '\u{1F52E}', name: 'crystal_ball', category: 'Activities' },
  { emoji: '\u{1F3C6}', name: 'trophy', category: 'Activities' },
  { emoji: '\u{1F396}\u{FE0F}', name: 'medal', category: 'Activities' },

  // Travel & Places
  { emoji: '\u{1F697}', name: 'car', category: 'Travel' },
  { emoji: '\u{1F68C}', name: 'bus', category: 'Travel' },
  { emoji: '\u{1F682}', name: 'train', category: 'Travel' },
  { emoji: '\u{2708}\u{FE0F}', name: 'airplane', category: 'Travel' },
  { emoji: '\u{1F680}', name: 'rocket', category: 'Travel' },
  { emoji: '\u{1F6F8}', name: 'ufo', category: 'Travel' },
  { emoji: '\u{1F6A2}', name: 'ship', category: 'Travel' },
  { emoji: '\u{1F3E0}', name: 'house', category: 'Travel' },
  { emoji: '\u{1F3D7}\u{FE0F}', name: 'construction', category: 'Travel' },
  { emoji: '\u{1F3EB}', name: 'school', category: 'Travel' },
  { emoji: '\u{1F3E5}', name: 'hospital', category: 'Travel' },
  { emoji: '\u{1F3F0}', name: 'castle', category: 'Travel' },
  { emoji: '\u{26EA}', name: 'church', category: 'Travel' },
  { emoji: '\u{1F5FC}', name: 'tokyo_tower', category: 'Travel' },
  { emoji: '\u{1F5FD}', name: 'statue_of_liberty', category: 'Travel' },
  { emoji: '\u{1F30D}', name: 'earth_africa', category: 'Travel' },
  { emoji: '\u{1F30E}', name: 'earth_americas', category: 'Travel' },
  { emoji: '\u{1F30F}', name: 'earth_asia', category: 'Travel' },
  { emoji: '\u{1F319}', name: 'crescent_moon', category: 'Travel' },
  { emoji: '\u{2B50}', name: 'star', category: 'Travel' },
  { emoji: '\u{1F31F}', name: 'glowing_star', category: 'Travel' },
  { emoji: '\u{2600}\u{FE0F}', name: 'sun', category: 'Travel' },
  { emoji: '\u{1F324}\u{FE0F}', name: 'sun_behind_cloud', category: 'Travel' },
  { emoji: '\u{26C5}', name: 'partly_sunny', category: 'Travel' },
  { emoji: '\u{1F327}\u{FE0F}', name: 'rain', category: 'Travel' },
  { emoji: '\u{26C8}\u{FE0F}', name: 'thunder_rain', category: 'Travel' },
  { emoji: '\u{2744}\u{FE0F}', name: 'snowflake', category: 'Travel' },
  { emoji: '\u{1F525}', name: 'fire', category: 'Travel' },
  { emoji: '\u{1F30A}', name: 'wave', category: 'Travel' },
  { emoji: '\u{1F308}', name: 'rainbow', category: 'Travel' },

  // Symbols & Hearts
  { emoji: '\u{2764}\u{FE0F}', name: 'heart', category: 'Symbols' },
  { emoji: '\u{1F9E1}', name: 'orange_heart', category: 'Symbols' },
  { emoji: '\u{1F49B}', name: 'yellow_heart', category: 'Symbols' },
  { emoji: '\u{1F49A}', name: 'green_heart', category: 'Symbols' },
  { emoji: '\u{1F499}', name: 'blue_heart', category: 'Symbols' },
  { emoji: '\u{1F49C}', name: 'purple_heart', category: 'Symbols' },
  { emoji: '\u{1F5A4}', name: 'black_heart', category: 'Symbols' },
  { emoji: '\u{1F494}', name: 'broken_heart', category: 'Symbols' },
  { emoji: '\u{1F495}', name: 'two_hearts', category: 'Symbols' },
  { emoji: '\u{1F496}', name: 'sparkling_heart', category: 'Symbols' },
  { emoji: '\u{1F493}', name: 'heartbeat', category: 'Symbols' },
  { emoji: '\u{1F498}', name: 'cupid', category: 'Symbols' },
  { emoji: '\u{1F4AF}', name: '100', category: 'Symbols' },
  { emoji: '\u{1F4A2}', name: 'anger', category: 'Symbols' },
  { emoji: '\u{1F4A5}', name: 'boom', category: 'Symbols' },
  { emoji: '\u{1F4AB}', name: 'dizzy_star', category: 'Symbols' },
  { emoji: '\u{1F4A6}', name: 'sweat_drops', category: 'Symbols' },
  { emoji: '\u{1F4A8}', name: 'dash', category: 'Symbols' },
  { emoji: '\u{1F4AC}', name: 'speech_balloon', category: 'Symbols' },
  { emoji: '\u{1F4AD}', name: 'thought_balloon', category: 'Symbols' },
  { emoji: '\u{1F4A4}', name: 'zzz', category: 'Symbols' },
  { emoji: '\u{2714}\u{FE0F}', name: 'check', category: 'Symbols' },
  { emoji: '\u{274C}', name: 'cross_mark', category: 'Symbols' },
  { emoji: '\u{2757}', name: 'exclamation', category: 'Symbols' },
  { emoji: '\u{2753}', name: 'question', category: 'Symbols' },
  { emoji: '\u{26A0}\u{FE0F}', name: 'warning', category: 'Symbols' },
  { emoji: '\u{1F6AB}', name: 'no_entry', category: 'Symbols' },
  { emoji: '\u{267B}\u{FE0F}', name: 'recycle', category: 'Symbols' },

  // Flags (small selection)
  { emoji: '\u{1F1FA}\u{1F1F8}', name: 'flag_us', category: 'Flags' },
  { emoji: '\u{1F1EC}\u{1F1E7}', name: 'flag_gb', category: 'Flags' },
  { emoji: '\u{1F1EF}\u{1F1F5}', name: 'flag_jp', category: 'Flags' },
  { emoji: '\u{1F1F0}\u{1F1F7}', name: 'flag_kr', category: 'Flags' },
  { emoji: '\u{1F1E8}\u{1F1F3}', name: 'flag_cn', category: 'Flags' },
  { emoji: '\u{1F1EB}\u{1F1F7}', name: 'flag_fr', category: 'Flags' },
  { emoji: '\u{1F1E9}\u{1F1EA}', name: 'flag_de', category: 'Flags' },
  { emoji: '\u{1F1EA}\u{1F1F8}', name: 'flag_es', category: 'Flags' },
  { emoji: '\u{1F1E7}\u{1F1F7}', name: 'flag_br', category: 'Flags' },
  { emoji: '\u{1F1F7}\u{1F1FA}', name: 'flag_ru', category: 'Flags' },
  { emoji: '\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}', name: 'rainbow_flag', category: 'Flags' },
  { emoji: '\u{1F3F4}\u{200D}\u{2620}\u{FE0F}', name: 'pirate_flag', category: 'Flags' },
]

// ── Module-level cache ───────────────────────────────────────────────
const customEmojis = ref<CustomEmoji[]>([])
const loaded = ref(false)
const loading = ref(false)

export function useEmojis() {
  const auth = useAuthStore()

  async function fetchCustomEmojis() {
    if (loaded.value || loading.value) return
    loading.value = true
    try {
      const { data } = await apiFetch<CustomEmoji[]>('/v1/custom_emojis', {
        token: auth.token ?? undefined,
      })
      customEmojis.value = data.filter((e) => e.visible_in_picker)
      loaded.value = true
    } catch {
      // Silently fail — custom emojis are optional
    } finally {
      loading.value = false
    }
  }

  const customEmojisByCategory = computed(() => {
    const map = new Map<string, CustomEmoji[]>()
    for (const emoji of customEmojis.value) {
      const cat = emoji.category ?? '기타'
      if (!map.has(cat)) map.set(cat, [])
      map.get(cat)!.push(emoji)
    }
    return map
  })

  const unicodeCategories = computed(() => {
    const cats = new Set<string>()
    for (const e of UNICODE_EMOJIS) cats.add(e.category)
    return [...cats]
  })

  function searchEmojis(query: string): { custom: CustomEmoji[]; unicode: UnicodeEmoji[] } {
    const q = query.toLowerCase()
    return {
      custom: customEmojis.value.filter((e) => e.shortcode.toLowerCase().includes(q)),
      unicode: UNICODE_EMOJIS.filter((e) => e.name.toLowerCase().includes(q)),
    }
  }

  function getUnicodeByCategory(category: string): UnicodeEmoji[] {
    return UNICODE_EMOJIS.filter((e) => e.category === category)
  }

  return {
    customEmojis,
    customEmojisByCategory,
    unicodeCategories,
    loaded,
    loading,
    fetchCustomEmojis,
    searchEmojis,
    getUnicodeByCategory,
    UNICODE_EMOJIS,
  }
}
