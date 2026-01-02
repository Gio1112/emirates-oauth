// server.js - Railway Discord OAuth Server
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const app = express();

// Environment variables (set these in Railway)
const PORT = process.env.PORT || 3000;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://giorgio.is-a.dev/emirates/careers';

// Middleware
app.use(cors({
    origin: FRONTEND_URL,
    credentials: true
}));
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'Emirates Careers OAuth Server Running',
        version: '1.0.0'
    });
});

// Exchange Discord authorization code for access token
app.post('/api/auth/discord', async (req, res) => {
    const { code } = req.body;

    if (!code) {
        return res.status(400).json({ error: 'Authorization code is required' });
    }

    try {
        // Exchange code for access token
        const tokenResponse = await axios.post(
            'https://discord.com/api/oauth2/token',
            new URLSearchParams({
                client_id: DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: FRONTEND_URL
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        const { access_token } = tokenResponse.data;

        // Get user information
        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: {
                Authorization: `Bearer ${access_token}`
            }
        });

        const user = userResponse.data;

        // Return user data to frontend
        res.json({
            id: user.id,
            username: user.username,
            discriminator: user.discriminator,
            avatar: user.avatar 
                ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
                : `https://cdn.discordapp.com/embed/avatars/${parseInt(user.discriminator) % 5}.png`,
            email: user.email
        });

    } catch (error) {
        console.error('Discord OAuth Error:', error.response?.data || error.message);
        res.status(500).json({ 
            error: 'Failed to authenticate with Discord',
            details: error.response?.data?.error_description || error.message
        });
    }
});

// Optional: Webhook endpoint to send applications to Discord (DEPRECATED - use /api/applications instead)
app.post('/api/webhook/application', async (req, res) => {
    const { application, webhookUrl } = req.body;

    if (!application || !webhookUrl) {
        return res.status(400).json({ error: 'Application data and webhook URL required' });
    }

    try {
        // Build Discord embed
        const embed = {
            title: 'Flight Deck Application',
            color: 0xd71921, // Emirates red
            fields: [
                {
                    name: 'Applicant Name',
                    value: '```' + application.fullName + '```',
                    inline: false
                },
                {
                    name: 'Position',
                    value: '```' + application.position + '```',
                    inline: true
                },
                {
                    name: 'Experience',
                    value: '```' + application.experience + ' hours```',
                    inline: true
                },
                {
                    name: 'Email',
                    value: '```' + application.email + '```',
                    inline: false
                },
                {
                    name: 'License Number',
                    value: '```' + application.licenseNumber + '```',
                    inline: false
                },
                {
                    name: 'Why Emirates?',
                    value: '```' + application.motivation.substring(0, 1024) + '```',
                    inline: false
                },
                {
                    name: 'Previous Experience',
                    value: '```' + application.experienceDetail.substring(0, 1024) + '```',
                    inline: false
                }
            ],
            thumbnail: {
                url: application.userAvatar
            },
            footer: {
                text: `Application ID: ${application.id}`
            },
            timestamp: new Date().toISOString()
        };

        // Send to Discord webhook
        await axios.post(webhookUrl, {
            username: 'Emirates Applications',
            embeds: [embed],
            components: [
                {
                    type: 1,
                    components: [
                        {
                            type: 2,
                            style: 3,
                            label: 'Accept',
                            custom_id: `accept_${application.id}`,
                            emoji: { name: '✅' }
                        },
                        {
                            type: 2,
                            style: 4,
                            label: 'Deny',
                            custom_id: `deny_${application.id}`,
                            emoji: { name: '❌' }
                        }
                    ]
                }
            ]
        });

        res.json({ success: true, message: 'Application sent to Discord' });

    } catch (error) {
        console.error('Webhook Error:', error.response?.data || error.message);
        res.status(500).json({ 
            error: 'Failed to send webhook',
            details: error.message
        });
    }
});

// In-memory storage (in production, use a real database like MongoDB/PostgreSQL)
// WARNING: Data will be lost when server restarts! 
// For production, connect to Railway PostgreSQL or MongoDB add-on
const applications = new Map();

// Get all applications
app.get('/api/applications', async (req, res) => {
    try {
        const allApps = Array.from(applications.values());
        res.json({ applications: allApps });
    } catch (error) {
        console.error('Error fetching applications:', error);
        res.status(500).json({ error: 'Failed to fetch applications' });
    }
});

// Get applications by user ID
app.get('/api/applications/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const userApps = Array.from(applications.values()).filter(
            app => app.userId === userId
        );
        res.json({ applications: userApps });
    } catch (error) {
        console.error('Error fetching user applications:', error);
        res.status(500).json({ error: 'Failed to fetch applications' });
    }
});

// Submit new application
app.post('/api/applications', async (req, res) => {
    try {
        const application = req.body;
        
        if (!application.id) {
            return res.status(400).json({ error: 'Application ID is required' });
        }

        applications.set(application.id, application);
        
        // Send to Discord webhook if provided
        if (application.webhookUrl) {
            try {
                const embed = {
                    title: 'Flight Deck Application',
                    color: 0xd71921,
                    fields: [
                        {
                            name: 'Applicant Name',
                            value: '```' + application.fullName + '```',
                            inline: false
                        },
                        {
                            name: 'Position',
                            value: '```' + application.position + '```',
                            inline: true
                        },
                        {
                            name: 'Experience',
                            value: '```' + application.experience + ' hours```',
                            inline: true
                        },
                        {
                            name: 'Email',
                            value: '```' + application.email + '```',
                            inline: false
                        },
                        {
                            name: 'License Number',
                            value: '```' + application.licenseNumber + '```',
                            inline: false
                        },
                        {
                            name: 'Why Emirates?',
                            value: '```' + application.motivation.substring(0, 1024) + '```',
                            inline: false
                        },
                        {
                            name: 'Previous Experience',
                            value: '```' + application.experienceDetail.substring(0, 1024) + '```',
                            inline: false
                        }
                    ],
                    thumbnail: {
                        url: application.userAvatar
                    },
                    footer: {
                        text: `Application ID: ${application.id}`
                    },
                    timestamp: new Date().toISOString()
                };

                await axios.post(application.webhookUrl, {
                    username: 'Emirates Applications',
                    embeds: [embed],
                    components: [
                        {
                            type: 1,
                            components: [
                                {
                                    type: 2,
                                    style: 3,
                                    label: 'Accept',
                                    custom_id: `accept_${application.id}`,
                                    emoji: { name: '✅' }
                                },
                                {
                                    type: 2,
                                    style: 4,
                                    label: 'Deny',
                                    custom_id: `deny_${application.id}`,
                                    emoji: { name: '❌' }
                                }
                            ]
                        }
                    ]
                });
            } catch (webhookError) {
                console.error('Webhook failed:', webhookError);
                // Don't fail the submission if webhook fails
            }
        }

        res.json({ success: true, application });
    } catch (error) {
        console.error('Error saving application:', error);
        res.status(500).json({ error: 'Failed to save application' });
    }
});

// Update application status
app.patch('/api/applications/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, reviewedBy } = req.body;

        const application = applications.get(id);
        
        if (!application) {
            return res.status(404).json({ error: 'Application not found' });
        }

        application.status = status;
        application.reviewedAt = new Date().toISOString();
        application.reviewedBy = reviewedBy;

        applications.set(id, application);

        res.json({ success: true, application });
    } catch (error) {
        console.error('Error updating application:', error);
        res.status(500).json({ error: 'Failed to update application' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Emirates OAuth Server running on port ${PORT}`);
    console.log(`📍 Frontend URL: ${FRONTEND_URL}`);
});

module.exports = app;
