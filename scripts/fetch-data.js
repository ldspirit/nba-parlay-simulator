const fs = require('fs');

const API_KEY = process.env.ODDS_API_KEY;
const SPORT = 'basketball_nba';
const DAILY_STAKE = 0.10;
const DATA_FILE = 'data.json';

// Load existing data
let data = {
    games: {},
    dailyParlays: {},
    oddsFetchedDates: {},
    lastUpdate: null,
    creditsRemaining: null,
    creditsUsed: 0
};

try {
    if (fs.existsSync(DATA_FILE)) {
        data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
} catch (e) {
    console.log('Starting fresh data file');
}

function getTodayKey() {
    return new Date().toISOString().split('T')[0];
}

function getDateKey(dateStr) {
    return new Date(dateStr).toISOString().split('T')[0];
}

function getBestOdds(bookmakers, teamName) {
    const preferred = ['draftkings', 'fanduel', 'betmgm'];
    for (const pref of preferred) {
        const bm = bookmakers.find(b => b.key === pref);
        if (bm) {
            const market = bm.markets.find(m => m.key === 'h2h');
            if (market) {
                const outcome = market.outcomes.find(o => o.name === teamName);
                if (outcome) return { odds: outcome.price, bookmaker: bm.title };
            }
        }
    }
    for (const bm of bookmakers) {
        const market = bm.markets.find(m => m.key === 'h2h');
        if (market) {
            const outcome = market.outcomes.find(o => o.name === teamName);
            if (outcome) return { odds: outcome.price, bookmaker: bm.title };
        }
    }
    return null;
}

function shouldFetchOdds() {
    const today = getTodayKey();
    if (data.oddsFetchedDates[today]) return false;

    // Find first game today
    let firstGameTime = null;
    for (const gameId in data.games) {
        const game = data.games[gameId];
        if (game.dateKey === today && !game.completed) {
            const gameTime = new Date(game.startTime);
            if (!firstGameTime || gameTime < firstGameTime) {
                firstGameTime = gameTime;
            }
        }
    }

    if (!firstGameTime) return true; // Unknown, fetch to discover

    const hoursUntilFirstGame = (firstGameTime - new Date()) / (1000 * 60 * 60);
    return hoursUntilFirstGame <= 4 && hoursUntilFirstGame > 0;
}

async function fetchOdds() {
    const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds?apiKey=${API_KEY}&regions=us&markets=h2h&oddsFormat=decimal`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Odds API Error: ${response.status}`);
    const remaining = response.headers.get('x-requests-remaining');
    const used = response.headers.get('x-requests-used');
    if (remaining) data.creditsRemaining = parseInt(remaining);
    if (used) data.creditsUsed = parseInt(used);
    console.log(`Credits remaining: ${remaining}, used: ${used}`);
    return response.json();
}

async function fetchScores() {
    const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/scores?apiKey=${API_KEY}&daysFrom=3`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Scores API Error: ${response.status}`);
    const remaining = response.headers.get('x-requests-remaining');
    const used = response.headers.get('x-requests-used');
    if (remaining) data.creditsRemaining = parseInt(remaining);
    if (used) data.creditsUsed = parseInt(used);
    console.log(`Credits remaining: ${remaining}, used: ${used}`);
    return response.json();
}

function calculateDailyParlays() {
    const gamesByDate = {};
    for (const gameId in data.games) {
        const game = data.games[gameId];
        if (!gamesByDate[game.dateKey]) gamesByDate[game.dateKey] = [];
        gamesByDate[game.dateKey].push(game);
    }

    for (const dateKey in gamesByDate) {
        const games = gamesByDate[dateKey];
        const completedGames = games.filter(g => g.completed && g.winner);
        const allCompleted = games.every(g => g.completed);

        let parlayOdds = 1;
        let allHaveOdds = true;

        for (const game of completedGames) {
            const winnerOdds = game.winner === game.homeTeam ? game.homeOdds : game.awayOdds;
            if (winnerOdds) parlayOdds *= winnerOdds;
            else allHaveOdds = false;
        }

        data.dailyParlays[dateKey] = {
            totalGames: games.length,
            completedGames: completedGames.length,
            allCompleted,
            totalOdds: allHaveOdds && completedGames.length > 0 ? parlayOdds : null,
            payout: allHaveOdds && completedGames.length > 0 ? DAILY_STAKE * parlayOdds : null,
            status: allCompleted ? 'completed' : (completedGames.length > 0 ? 'in_progress' : 'pending')
        };
    }
}

async function main() {
    console.log('=== NBA Parlay Data Fetcher ===');
    console.log(`Time: ${new Date().toISOString()}`);

    const fetchOddsNow = shouldFetchOdds();
    console.log(`Should fetch odds: ${fetchOddsNow}`);

    try {
        if (fetchOddsNow) {
            console.log('Fetching odds...');
            const oddsData = await fetchOdds();
            console.log(`Got ${oddsData.length} games with odds`);

            for (const game of oddsData) {
                const dateKey = getDateKey(game.commence_time);
                const homeOdds = getBestOdds(game.bookmakers, game.home_team);
                const awayOdds = getBestOdds(game.bookmakers, game.away_team);

                if (!data.games[game.id]) {
                    data.games[game.id] = {
                        id: game.id,
                        homeTeam: game.home_team,
                        awayTeam: game.away_team,
                        startTime: game.commence_time,
                        dateKey,
                        homeOdds: homeOdds?.odds || null,
                        awayOdds: awayOdds?.odds || null,
                        completed: false,
                        winner: null,
                        homeScore: null,
                        awayScore: null
                    };
                }
            }

            data.oddsFetchedDates[getTodayKey()] = Date.now();
        }

        console.log('Fetching scores...');
        const scoresData = await fetchScores();

        let newCompleted = 0;
        for (const game of scoresData) {
            if (data.games[game.id] && game.completed && !data.games[game.id].completed) {
                const trackedGame = data.games[game.id];
                trackedGame.completed = true;

                if (game.scores?.length >= 2) {
                    const homeScore = game.scores.find(s => s.name === trackedGame.homeTeam);
                    const awayScore = game.scores.find(s => s.name === trackedGame.awayTeam);

                    if (homeScore && awayScore) {
                        trackedGame.homeScore = parseInt(homeScore.score);
                        trackedGame.awayScore = parseInt(awayScore.score);
                        trackedGame.winner = trackedGame.homeScore > trackedGame.awayScore
                            ? trackedGame.homeTeam : trackedGame.awayTeam;
                        newCompleted++;
                    }
                }
            }
        }

        console.log(`New completed games: ${newCompleted}`);

        calculateDailyParlays();
        data.lastUpdate = new Date().toISOString();

        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        console.log('Data saved!');

    } catch (e) {
        console.error('Error:', e.message);
        process.exit(1);
    }
}

main();
